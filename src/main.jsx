import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter, Routes, Route } from 'react-router-dom'
import './index.css'
import App from './App.tsx'

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <BrowserRouter>
      <Routes>
        <Route path="/:slug/:leadPhone" element={<App />} />
        <Route path="/:slug" element={<App />} />
      </Routes>
    </BrowserRouter>
  </StrictMode>,
)
