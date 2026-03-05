import { ShipmentRecord, StandardItem, ChecklistItem } from './types';

const APP_ID = process.env.FEISHU_APP_ID!;
const APP_SECRET = process.env.FEISHU_APP_SECRET!;
const APP_TOKEN = process.env.FEISHU_BITABLE_APP_TOKEN!;

// Table IDs
const TABLE_IDS = {
  STANDARDS: process.env.TABLE_ID_STANDARDS!,
  SHIPMENTS: process.env.TABLE_ID_SHIPMENTS!,
  CHECKLIST: process.env.TABLE_ID_CHECKLIST!,
};

// Always use field names as keys, so we can work with Chinese column names directly.
const FIELD_KEY = 'field_name';

function withFieldKey(path: string) {
  return path.includes('?') ? `${path}&field_key=${FIELD_KEY}` : `${path}?field_key=${FIELD_KEY}`;
}

export class FeishuClient {
  private static tenantAccessToken: string = '';
  private static tokenExpireAt: number = 0;

  private static async getAccessToken() {
    if (this.tenantAccessToken && Date.now() < this.tokenExpireAt) return this.tenantAccessToken;

    const res = await fetch('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ app_id: APP_ID, app_secret: APP_SECRET }),
    });

    const data = await res.json();
    if (data.code !== 0) throw new Error(`Auth failed: ${data.msg}`);

    this.tenantAccessToken = data.tenant_access_token;
    this.tokenExpireAt = Date.now() + (data.expire - 60) * 1000;
    return this.tenantAccessToken;
  }

  private static async request(path: string, method: string = 'GET', body?: any, isFileUpload: boolean = false) {
    const token = await this.getAccessToken();
    const headers: any = { Authorization: `Bearer ${token}` };

    if (!isFileUpload) headers['Content-Type'] = 'application/json';

    const res = await fetch(`https://open.feishu.cn/open-apis${path}`, {
      method,
      headers,
      body: isFileUpload ? body : (body ? JSON.stringify(body) : undefined),
    });

    const data = await res.json();
    if (data.code !== 0) {
      console.error('Feishu API Error:', JSON.stringify(data));
      throw new Error(`API Error [${path}]: ${data.msg}`);
    }
    return data.data;
  }

  // --- Bitable Operations ---

  static async getShipment(recordId: string): Promise<ShipmentRecord> {
    const data = await this.request(
      withFieldKey(`/bitable/v1/apps/${APP_TOKEN}/tables/${TABLE_IDS.SHIPMENTS}/records/${recordId}`)
    );
    return data.record;
  }

  /**
   * Fetch standards for a SKU. If version is provided and the standards table has a "版本" field,
   * we will filter by it. Otherwise, we only filter by SKU.
   *
   * NOTE: The filter expression uses the *field name* exactly as shown in Bitable.
   */
  static async getStandards(sku: string, version?: string): Promise<StandardItem[]> {
    const skuField = process.env.FIELD_STANDARD_SKU || 'SKU';
    const versionField = process.env.FIELD_STANDARD_VERSION || '版本';

    let filter = `CurrentValue.[${skuField}]="${sku}"`;
    if (version && version.trim().length > 0) {
      filter = `AND(CurrentValue.[${skuField}]="${sku}", CurrentValue.[${versionField}]="${version}")`;
    }

    const data = await this.request(
      withFieldKey(
        `/bitable/v1/apps/${APP_TOKEN}/tables/${TABLE_IDS.STANDARDS}/records?filter=${encodeURIComponent(filter)}&page_size=500`
      )
    );
    return data.items || [];
  }

  /**
   * List all checklist rows and filter in-memory by the linked shipment recordId.
   * This is more reliable than Bitable link-field filtering which can be inconsistent across configs.
   */
  static async getChecklistByShipment(shipmentRecordId: string): Promise<ChecklistItem[]> {
    const linkField = process.env.FIELD_CHECKLIST_LINK || '出货合同';

    let all: ChecklistItem[] = [];
    let pageToken: string | undefined = undefined;

    while (true) {
      const qs = new URLSearchParams({ page_size: '500' });
      if (pageToken) qs.set('page_token', pageToken);

      const data = await this.request(
        withFieldKey(`/bitable/v1/apps/${APP_TOKEN}/tables/${TABLE_IDS.CHECKLIST}/records?${qs.toString()}`)
      );

      const items: ChecklistItem[] = data.items || [];
      all = all.concat(items);

      pageToken = data.page_token;
      if (!pageToken) break;
    }

    const filtered = all.filter((rec) => {
      const v = rec.fields?.[linkField];
      if (!v) return false;

      // Possible shapes:
      // - ["rec_xxx"]
      // - [{ record_id: "rec_xxx", text: "..." }]
      // - [{ record_ids: ["rec_xxx"] }]
      if (Array.isArray(v)) {
        for (const it of v) {
          if (typeof it === 'string' && it === shipmentRecordId) return true;
          if (it && typeof it === 'object') {
            if ((it as any).record_id && (it as any).record_id === shipmentRecordId) return true;
            if (Array.isArray((it as any).record_ids) && (it as any).record_ids.includes(shipmentRecordId)) return true;
          }
        }
      } else if (typeof v === 'string') {
        return v === shipmentRecordId;
      }
      return false;
    });

    return filtered;
  }

  static async createChecklistItems(recordsFields: any[]) {
    // Batch create, max 100 per request
    const chunkSize = 100;
    for (let i = 0; i < recordsFields.length; i += chunkSize) {
      const chunk = recordsFields.slice(i, i + chunkSize);
      await this.request(
        withFieldKey(`/bitable/v1/apps/${APP_TOKEN}/tables/${TABLE_IDS.CHECKLIST}/records/batch_create`),
        'POST',
        { records: chunk.map((fields: any) => ({ fields })) }
      );
    }
  }

  static async updateShipment(recordId: string, fields: any) {
    await this.request(
      withFieldKey(`/bitable/v1/apps/${APP_TOKEN}/tables/${TABLE_IDS.SHIPMENTS}/records/${recordId}`),
      'PUT',
      { fields }
    );
  }

  static async updateChecklistItems(records: { recordId: string; fields: any }[]) {
    // Batch update, max 100 per request
    const chunkSize = 100;
    for (let i = 0; i < records.length; i += chunkSize) {
      const chunk = records.slice(i, i + chunkSize);
      await this.request(
        withFieldKey(`/bitable/v1/apps/${APP_TOKEN}/tables/${TABLE_IDS.CHECKLIST}/records/batch_update`),
        'POST',
        { records: chunk }
      );
    }
  }

  // --- Drive Operations ---

  static async uploadFile(fileBuffer: Buffer, fileName: string, size: number) {
    const formData = new FormData();
    formData.append('file_name', fileName);
    formData.append('parent_type', 'bitable_image');
    formData.append('parent_node', APP_TOKEN);
    formData.append('size', size.toString());

    const blob = new Blob([fileBuffer]);
    formData.append('file', blob, fileName);

    const data = await this.request('/drive/v1/medias/upload_all', 'POST', formData, true);
    return data.file_token;
  }
}
