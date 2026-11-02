/** In-memory scoped permission; Turnstile tokens are never cached or replayed. */
export class AccessSession {
  constructor({authorize, request, ticketField, errorCode, now = Date.now}) {
    Object.assign(this,{authorize,requestJSON:request,ticketField,errorCode,now});
    this.scopes = new Map();
  }

  entry(scope) {
    if (!this.scopes.has(scope)) this.scopes.set(scope,{current:null,pending:null});
    return this.scopes.get(scope);
  }

  invalidate(scope, rejectedTicket) {
    const entry = this.entry(scope);
    // Concurrent Word extractions/polls may reject the old ticket after renewal.
    if (entry.current?.ticket === rejectedTicket) entry.current = null;
  }

  async getTicket(scope) {
    const entry = this.entry(scope);
    if (entry.current && this.now() < entry.current.expiry - 60_000) return entry.current.ticket;
    if (entry.pending) return entry.pending;
    entry.current = null;
    entry.pending = (async () => {
      const result = await this.authorize(scope);
      const expiry = Date.parse(result.expiresAt);
      if (typeof result.ticket !== 'string' || !result.ticket || !Number.isFinite(expiry) || expiry <= this.now()) {
        throw new Error('لم يصدر تصريح صالح للعملية. أعد المحاولة.');
      }
      entry.current = {ticket:result.ticket,expiry};
      return result.ticket;
    })();
    try {return await entry.pending;}
    catch (error) {error.authorizationFailed = true;throw error;}
    finally {entry.pending = null;}
  }

  async request(scope, path, data) {
    for (let attempt = 0; attempt < 2; attempt++) {
      const ticket = await this.getTicket(scope);
      try {
        return await this.requestJSON(path,{...data,[this.ticketField]:ticket});
      } catch (error) {
        // These codes are emitted only BEFORE fetching news or submitting to IA.
        // Never replay an archive submission after a network error or generic 403.
        if (error.status !== 403 || error.code !== this.errorCode) throw error;
        this.invalidate(scope,ticket);
        if (attempt === 1) throw error;
      }
    }
  }
}
