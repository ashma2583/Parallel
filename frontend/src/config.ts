/**
 * Runtime configuration. Override with a `.env.local` file, e.g.
 *   VITE_STDB_URI=ws://127.0.0.1:3000
 *   VITE_STDB_DATABASE=parallel
 *   VITE_BACKEND_URL=http://127.0.0.1:8000
 */
export const STDB_URI: string = import.meta.env.VITE_STDB_URI ?? 'ws://127.0.0.1:3000'
export const STDB_DATABASE: string = import.meta.env.VITE_STDB_DATABASE ?? 'parallel'
export const BACKEND_URL: string = import.meta.env.VITE_BACKEND_URL ?? 'http://127.0.0.1:8000'
