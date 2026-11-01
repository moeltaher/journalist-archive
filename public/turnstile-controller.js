/**
 * Two independent on-demand Turnstile widgets.
 * Using explicit CSS #id selectors avoids the "Unable to find a container" error
 * caused by passing a bare ID. Neither widget is rendered in a hidden panel.
 */
export const TURNSTILE_HOSTS = Object.freeze({
  inspect:'inspect-turnstile-widget',
  archive:'archive-turnstile-widget'
});

export class TurnstileController {
  constructor({getApi, locate}) {
    this.getApi = getApi;
    this.locate = locate;
    this.siteKey = '';
    this.widgets = new Map();
    this.pending = new Map();
  }

  setSiteKey(nextKey) {
    if (nextKey === this.siteKey) return;
    const api = this.getApi();
    for (const pending of this.pending.values()) {
      pending.reject(new Error('تغيّرت إعدادات Turnstile. أعد محاولة التحقق.'));
    }
    this.pending.clear();
    for (const id of this.widgets.values()) {
      try { api?.remove?.(id); } catch { /* stale widget; next attempt creates a new one */ }
    }
    this.widgets.clear();
    this.siteKey = nextKey || '';
  }

  finish(action, token = null, error = null) {
    const pending = this.pending.get(action);
    if (!pending) return;
    this.pending.delete(action);
    if (error) pending.reject(error);
    else if (typeof token !== 'string' || !token) pending.reject(new Error('لم يصدر Turnstile رمز تحقق صالحًا.'));
    else pending.resolve(token);
  }

  execute(action) {
    const hostId = TURNSTILE_HOSTS[action];
    if (!hostId) throw new Error('عملية تحقق غير مدعومة.');
    if (!this.siteKey) throw new Error('لم يتم إعداد مفتاح Turnstile العام.');
    if (this.pending.has(action)) throw new Error('يوجد تحقق أمني جارٍ بالفعل.');
    const api = this.getApi();
    if (typeof api?.render !== 'function' || typeof api?.execute !== 'function') {
      throw new Error('لم تُحمّل مكتبة Turnstile. جرّب إعادة تحميل الصفحة.');
    }
    const host = this.locate(hostId);
    if (!host || host.isConnected === false || host.closest?.('[hidden]')) {
      throw new Error('موضع اختبار Turnstile غير متاح في الصفحة. أعد تحميل الموقع.');
    }

    let id = this.widgets.get(action);
    const fresh = id === undefined;
    if (fresh) {
      // Turnstile's documented API uses CSS selectors such as "#turnstile-widget".
      id = api.render('#' + hostId, {
        sitekey:this.siteKey,
        action,
        execution:'execute',
        appearance:'interaction-only',
        callback:token => this.finish(action, token),
        'error-callback':() => this.finish(action, null, new Error('فشل اختبار Turnstile. تحقق من الاتصال ثم أعد المحاولة.')),
        'expired-callback':() => this.finish(action, null, new Error('انتهت صلاحية الاختبار. أعد المحاولة.'))
      });
      if (id === null || id === undefined) throw new Error('تعذّر إنشاء اختبار Turnstile.');
      this.widgets.set(action, id);
    }

    return new Promise((resolve,reject) => {
      this.pending.set(action,{resolve,reject});
      try {
        if (!fresh) api.reset(id);
        api.execute(id);
      } catch (error) {
        this.finish(action, null, error);
      }
    });
  }
}
