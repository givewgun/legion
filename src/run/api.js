import 'dotenv/config';
import { loadConfig } from '../config/index.js';
import { connectDb } from '../db/client.js';
import { createRepo } from '../db/repo.js';
import { createApp } from '../api/app.js';

const cfg = loadConfig();
const repo = createRepo(connectDb(cfg.databaseUrl));
const app = createApp({ repo });

app.listen(cfg.apiPort, () => console.log(`[api] listening on :${cfg.apiPort}`));
