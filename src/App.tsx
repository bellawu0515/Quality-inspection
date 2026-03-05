
import { Routes, Route } from 'react-router-dom';
import Home from './pages/Home';
import Inspect from './pages/Inspect';

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<Home />} />
      <Route path="/inspect" element={<Inspect />} />
    </Routes>
  );
}
