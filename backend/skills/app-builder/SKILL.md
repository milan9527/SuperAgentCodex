---
name: app-builder
description: Guide for building web applications with persistent data storage on the Super Agent platform. Use this skill whenever the user asks to build, create, or develop a web app, dashboard, tool, or any interactive application. This skill teaches you how to use the platform's built-in Data API for backend storage.
---

# App Builder

Build full-stack web applications with persistent data storage on the Super Agent platform.

## When to Use

- User asks to "build an app", "create a dashboard", "make a tool"
- User needs an app that stores/retrieves data (expenses, tasks, inventory, etc.)
- User wants a BI dashboard or reporting tool
- Any request for an interactive web application

## Architecture

Apps on this platform are:
- **Frontend**: React + Vite (built to static files, served by the platform)
- **Backend**: The platform provides a built-in Data API — no custom server needed
- **Data**: Stored as JSONB documents in collections, queryable with filters and aggregations

## CRITICAL — Platform Data API

The platform provides a REST API for persistent data storage. Every published app gets access to it.

**Base URL**: `${API_BASE_URL}/api/apps/${APP_ID}/data`

The `API_BASE_URL` and `AUTH_TOKEN` are injected as environment variables at runtime.
The `APP_ID` is available after publishing (or use the session-based preview endpoint).

### Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/:collection` | List documents (supports `?limit=`, `?offset=`, `?filter=`, `?sort=`, `?order=`) |
| `GET` | `/:collection/:id` | Get single document |
| `POST` | `/:collection` | Create document (body = JSON object) |
| `PUT` | `/:collection/:id` | Replace document |
| `PATCH` | `/:collection/:id` | Merge-update document |
| `DELETE` | `/:collection/:id` | Delete document |
| `POST` | `/:collection/aggregate` | Run aggregation query |

### Filter Syntax

Pass `?filter={"status":"approved","department":"Engineering"}` as URL-encoded JSON.

### Aggregation

```json
POST /:collection/aggregate
{
  "groupBy": "department",
  "sum": "amount",
  "avg": "amount",
  "count": true,
  "where": { "status": "approved", "amount_gt": 100 },
  "orderBy": "sum_amount",
  "order": "desc",
  "limit": 10
}
```

Supported operators in `where`: exact match, `_gt`, `_gte`, `_lt`, `_lte`.

## Client SDK

When building an app, always include this helper module. Create it as `src/api.js` or `src/api.ts`:

```typescript
// src/api.ts — Platform Data API client
const API_BASE = import.meta.env.VITE_API_BASE_URL || window.location.origin;

// Extract APP_ID from the URL path: /api/apps/{uuid}/static/...
function getAppId(): string {
  const envId = import.meta.env.VITE_APP_ID;
  if (envId && envId !== 'preview' && envId.length > 10) return envId;
  // Auto-detect from URL when served by the platform
  const match = window.location.pathname.match(/\/api\/apps\/([a-f0-9-]{36})\//);
  if (match) return match[1];
  return '';
}
const APP_ID = getAppId();

function getToken(): string {
  // Try URL query param first (injected by platform iframe), then localStorage
  const urlToken = new URLSearchParams(window.location.search).get('token');
  if (urlToken) return urlToken;
  return localStorage.getItem('cognito_id_token')
    || localStorage.getItem('local_auth_token')
    || '';
}

function headers(): HeadersInit {
  return {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${getToken()}`,
  };
}

async function request(method: string, path: string, body?: unknown) {
  const url = `${API_BASE}/api/apps/${APP_ID}/data${path}`;
  const res = await fetch(url, {
    method,
    headers: headers(),
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`);
  if (res.status === 204) return null;
  return res.json();
}

export const db = {
  list: (collection: string, opts?: { limit?: number; offset?: number; filter?: object; sort?: string; order?: string }) => {
    const params = new URLSearchParams();
    if (opts?.limit) params.set('limit', String(opts.limit));
    if (opts?.offset) params.set('offset', String(opts.offset));
    if (opts?.filter) params.set('filter', JSON.stringify(opts.filter));
    if (opts?.sort) params.set('sort', opts.sort);
    if (opts?.order) params.set('order', opts.order);
    const qs = params.toString();
    return request('GET', `/${collection}${qs ? '?' + qs : ''}`).then((res: any) => res?.data || []);
  },
  get: (collection: string, id: string) => request('GET', `/${collection}/${id}`),
  create: (collection: string, data: object) => request('POST', `/${collection}`, data),
  update: (collection: string, id: string, data: object) => request('PUT', `/${collection}/${id}`, data),
  patch: (collection: string, id: string, data: object) => request('PATCH', `/${collection}/${id}`, data),
  remove: (collection: string, id: string) => request('DELETE', `/${collection}/${id}`),
  aggregate: (collection: string, query: object) => request('POST', `/${collection}/aggregate`, query),
};
```

## Build Rules

### Project Setup

1. Always use Vite + React (TypeScript or JavaScript)
2. Always set `base: './'` in `vite.config.ts` or `vite.config.js`
3. Always use `<HashRouter>` instead of `<BrowserRouter>` for React Router apps
4. Always include the `src/api.ts` client SDK above in every app that needs data
5. Always create a `tsconfig.json` if using TypeScript files (.tsx/.ts)

### CRITICAL — vite.config.js

Every app MUST have this vite config:

```javascript
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  base: './',
  plugins: [react()],
})
```

### CRITICAL — tsconfig.json

If the project uses .tsx or .ts files, ALWAYS create `tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2020",
    "useDefineForClassFields": true,
    "lib": ["ES2020", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "skipLibCheck": true,
    "moduleResolution": "bundler",
    "allowImportingTsExtensions": true,
    "isolatedModules": true,
    "noEmit": true,
    "jsx": "react-jsx",
    "strict": false
  },
  "include": ["src"]
}
```

### Environment Variables

Create `.env` in the app root:

```
VITE_API_BASE_URL=
```

> Note: Leave `VITE_API_BASE_URL` empty — the SDK automatically uses `window.location.origin`.
> The APP_ID is auto-detected from the URL path when served by the platform.
> No manual configuration needed.

### Data Modeling

- Use **collections** like database tables: `expenses`, `employees`, `tasks`
- Each document is a JSON object — no schema required
- Use consistent field names within a collection
- Store numeric values as numbers (not strings) for aggregation support
- Use ISO date strings for date fields

### Authentication

The app runs inside an authenticated iframe on the platform. The user's token is available in `localStorage` as `cognito_id_token` or `local_auth_token`. The `src/api.ts` client SDK handles this automatically.

### package.json build script

IMPORTANT: Use `vite build` directly, NOT `tsc -b && vite build`:

```json
{
  "scripts": {
    "dev": "vite",
    "build": "vite build",
    "preview": "vite preview"
  }
}
```

### Styling
- Use plain CSS or Tailwind (via CDN link in index.html)
- Keep it clean and professional
- Support dark mode if possible
- Make it responsive (mobile-friendly)

## Project Structure

```
app/
├── .env                    # API config (auto-injected on publish)
├── index.html              # Vite entry point
├── package.json            # Must have "build": "vite build"
├── tsconfig.json           # Required for .tsx/.ts files
├── vite.config.js          # Must have base: './'
└── src/
    ├── api.ts              # Data API client SDK
    ├── main.tsx            # React entry
    ├── App.tsx             # Root component with HashRouter
    ├── App.css             # Global styles
    └── pages/              # Page components
```

## Workflow

1. Create the app directory (e.g., `app/`)
2. Set up package.json, vite.config.js, tsconfig.json
3. Create `src/api.ts` with the SDK template
4. Build the UI with React components
5. Use `db.list()`, `db.create()`, `db.aggregate()` etc. for all data operations
6. The platform will auto-build and serve the app when user clicks Preview/Publish
