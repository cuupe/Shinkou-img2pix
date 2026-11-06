import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './styles.css';
import './workbench.css';
import { applyAppearance, readPreferences } from './lib/preferences';

applyAppearance(readPreferences());

ReactDOM.createRoot(document.getElementById('root')!).render(<React.StrictMode><App /></React.StrictMode>);
