import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import './app.css';
import { trackViewportHeight } from './viewport.ts';

matchMedia('(prefers-color-scheme: dark)').addEventListener('change', event => document.documentElement.classList.toggle('dark', event.matches));

trackViewportHeight();

createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>);
