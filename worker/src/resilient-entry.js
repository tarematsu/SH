import './fetch-guard.js';
import app from './cadenced-entry.js';
import { createPublicHealthCachedApp } from './public-health-cache.js';

export default createPublicHealthCachedApp(app);
