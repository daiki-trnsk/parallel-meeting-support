import { type JSX } from 'react';
import { BrowserRouter, Routes, Route } from 'react-router-dom';
import Home from './pages/Home';
import Meeting from './pages/Meeting';
import CommaDebug from './pages/CommaDebug';
import ControlDebug from './pages/ControlDebug';
import SpikeTest from './pages/SpikeTest';
import Sakura from './pages/Sakura';

function App(): JSX.Element {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/meeting" element={<Meeting />} />
        <Route path="/comma-debug" element={<CommaDebug />} />
        <Route path="/control-debug" element={<ControlDebug />} />
        <Route path="/spike-test" element={<SpikeTest />} />
        <Route path="/sakura" element={<Sakura />} />
      </Routes>
    </BrowserRouter>
  );
}

export default App;