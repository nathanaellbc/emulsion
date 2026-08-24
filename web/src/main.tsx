import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './ui/App';
import './styles/tokens.css';
import './styles/app.css';

const root = document.getElementById('root');
if (!root) throw new Error('#root is missing from the document');

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
