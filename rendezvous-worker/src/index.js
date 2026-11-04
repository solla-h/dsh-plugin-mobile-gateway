import { DurableObject } from 'cloudflare:workers'

import { handleBook, handleRequest } from './handler.js'

/** One SQLite-backed DO holds the whole personal address book (max 64 rows). */
export class Book extends DurableObject {
  async fetch(request) {
    return handleBook(this.ctx, request)
  }
}

export default {
  async fetch(request, env) {
    return handleRequest(request, env)
  },
}
