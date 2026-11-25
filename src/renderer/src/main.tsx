import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import './styles.css'

// Platform class for small layout differences (macOS draws traffic lights inside the toolbar).
const ua = navigator.userAgent
document.body.classList.add(ua.includes('Mac') ? 'platform-mac' : ua.includes('Windows') ? 'platform-win' : 'platform-linux')

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
)
