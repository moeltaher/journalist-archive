import {DurableObject} from 'cloudflare:workers';
import {initializeDailyQuota,consumeDailyQuota} from './security-rules.js';
export class ArchiveQuota extends DurableObject {
  constructor(ctx,env){super(ctx,env);initializeDailyQuota(this.ctx.storage);}
  async takeArchiveAttempt(){return consumeDailyQuota(this.ctx.storage,new Date().toISOString().slice(0,10));}
}