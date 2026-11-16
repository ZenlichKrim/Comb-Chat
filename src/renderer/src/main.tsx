import React from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import './styles/theme.css'
import './styles/base.css'
import './styles/markdown.css'
import './styles/app.css'

const el = document.getElementById('root')
if (!el) throw new Error('root element missing')
createRoot(el).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)

// Prevent the window from navigating on dropped files
window.addEventListener('dragover', (e) => e.preventDefault())
window.addEventListener('drop', (e) => e.preventDefault())
