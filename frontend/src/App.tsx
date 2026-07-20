import { type JSX } from 'react';
import { BrowserRouter, Routes, Route } from 'react-router-dom';
import Home from './pages/Home';
import Meeting from './pages/Meeting';
import CommaDebug from './pages/CommaDebug';
import SpikeTest from './pages/SpikeTest';

function App(): JSX.Element {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/meeting" element={<Meeting />} />
        <Route path="/comma-debug" element={<CommaDebug />} />
        <Route path="/spike-test" element={<SpikeTest />} />
      </Routes>
    </BrowserRouter>
  );
}

export default App;