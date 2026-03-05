export interface StandardItem {
  recordId: string;
  fields: Record<string, any>;
}

export interface ShipmentRecord {
  recordId: string;
  fields: Record<string, any>;
}

export interface ChecklistItem {
  recordId: string;
  fields: Record<string, any>;
}

export interface SubmitPayload {
  token: string;
  items: {
    recordId: string;
    result: 'Pass' | 'Fail' | 'N.A';
    defectCount: number;
    remark: string;
    photoTokens: string[];
  }[];
}
