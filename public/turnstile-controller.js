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
  constructor({getApi, locate, timeoutMs = 120_000,
    setTimer = (fn,ms) => setTimeout(fn,ms), clearTimer = id => clearTimeout(id)}) {
    this.getApi = getApi;
    this.locate = locate;
    this.siteKey = '';
    this.widgets = new Map();
    this.pending = new Map();
    this.timeoutMs = timeoutMs;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
  }

  setSiteKey(nextKey) {
    if (nextKey === this.siteKey) return;
    const api = this.getApi();
    for (const pending of this.pending.values()) {
      this.clearTimer(pending.timer);
      pending.reject(new Error('تغيّرت إعدادات Turnstile. أعد محاولة التحقق.'));
    }
    this.pending.clear();
    for (const id of this.widgets.values()) {
      try { api?.remove?.(id); } catch { /* stale widget; next attempt creates a new one */ }
    }
    this.widgets.clear();
    this.siteKey = nextKey || '';
  }

  finish(action, attempt, token = null, error = null) {
    const pending = this.pending.get(action);
    if (pending !== attempt) return;
    this.pending.delete(action);
    this.clearTimer(pending.timer);
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

    // Give every attempt its own callbacks. A late reply from a removed widget
    // must never supply an old, single-use token to a newer operation.
    const previous = this.widgets.get(action);
    if (previous !== undefined) {
      try {api.remove(previous);} catch { /* stale ID after a library reload */ }
      this.widgets.delete(action);
    }
    return new Promise((resolve,reject) => {
      const attempt = {resolve,reject,timer:null};
      this.pending.set(action,attempt);
      const fail = message => this.finish(action,attempt,null,new Error(message));
      try {
        attempt.timer = this.setTimer(() => fail('انتهت مهلة انتظار Turnstile. تحقق من الاتصال ثم أعد المحاولة.'),this.timeoutMs);
        const id = api.render('#' + hostId, {
          sitekey:this.siteKey, action, execution:'execute', appearance:'interaction-only',
          retry:'never', 'refresh-expired':'manual', 'refresh-timeout':'manual',
          callback:token => this.finish(action,attempt,token),
          'error-callback':() => {fail('فشل اختبار Turnstile. تحقق من الاتصال ثم أعد المحاولة.');return true;},
          'expired-callback':() => fail('انتهت صلاحية الاختبار. أعد المحاولة.'),
          'timeout-callback':() => fail('انتهت مهلة الاختبار التفاعلي. أعد المحاولة.'),
          'unsupported-callback':() => fail('المتصفح لا يدعم اختبار Turnstile. جرّب متصفحًا آخر.'),
          'before-interactive-callback':() => {
            if (this.pending.get(action) === attempt) host.scrollIntoView?.({behavior:'smooth',block:'center'});
          }
        });
        if (id === null || id === undefined) throw new Error('تعذّر إنشاء اختبار Turnstile.');
        this.widgets.set(action,id);
        // render() itself can call back synchronously on configuration errors.
        if (this.pending.get(action) === attempt) api.execute(id);
      } catch (error) {
        this.finish(action,attempt,null,error);
      }
    });
  }
}
