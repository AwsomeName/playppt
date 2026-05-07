import { Routes, Route } from 'react-router-dom';

import { AuthorWatermark } from './AuthorWatermark.js';
import { ManagePage } from './ManagePage.js';
import { PlayPage } from './PlayPage.js';

export function App() {
  return (
    <>
      <AuthorWatermark />
      <Routes>
        <Route path="/" element={<ManagePage />} />
        <Route path="/play/:sessionId" element={<PlayPage />} />
      </Routes>
    </>
  );
}