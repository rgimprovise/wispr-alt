// Resend HTTP API wrapper. We use direct fetch instead of the resend npm
// package to keep dependencies minimal — the API surface we need is one POST.

const RESEND_API_KEY = process.env.RESEND_API_KEY;
const RESEND_FROM = process.env.RESEND_FROM ?? "А-ГОЛОС <noreply@agolos.app>";
const APP_URL = process.env.APP_URL ?? "https://agolos.app";

export type MagicLinkEmail = {
  to: string;
  code: string;       // 6-digit OTP shown to user
  linkToken: string;  // opaque token for one-click verification URL
};

export async function sendMagicLinkEmail(args: MagicLinkEmail): Promise<void> {
  const url = `${APP_URL}/auth/verify-link?token=${encodeURIComponent(args.linkToken)}`;
  const subject = `Код для входа в А-ГОЛОС: ${args.code}`;
  const html = renderHtml({ code: args.code, url });
  const text = renderText({ code: args.code, url });

  if (!RESEND_API_KEY) {
    // Dev fallback: log to console instead of sending. Lets local testing
    // work without a Resend account.
    console.log("[email:dev] To:", args.to);
    console.log("[email:dev] Subject:", subject);
    console.log("[email:dev]", text);
    return;
  }

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${RESEND_API_KEY}`,
    },
    body: JSON.stringify({
      from: RESEND_FROM,
      to: [args.to],
      subject,
      html,
      text,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Resend error ${res.status}: ${body}`);
  }
}

function renderHtml({ code, url }: { code: string; url: string }): string {
  // Inline styles only — most clients strip <style>.
  // Dark А-ГОЛОС palette: charcoal #0B0D16, graphite card #161A24,
  // signal red #F22A37 accent. Mirrors brand/BRAND.md.
  return `<!doctype html>
<html><body style="font-family:-apple-system,'Inter',Segoe UI,Roboto,sans-serif;background:#0B0D16;padding:32px 16px;color:#F5F6F8;margin:0;">
  <div style="max-width:480px;margin:0 auto;background:#161A24;border-radius:20px;padding:32px;border:1px solid rgba(245,246,248,0.08);box-shadow:0 4px 24px rgba(0,0,0,0.40);">
    <div style="display:inline-block;font-size:11px;font-weight:600;letter-spacing:1.2px;color:#F22A37;text-transform:uppercase;margin-bottom:12px;">А-ГОЛОС</div>
    <h1 style="font-size:24px;font-weight:800;margin:0 0 20px 0;color:#F5F6F8;letter-spacing:-0.4px;">Код для входа</h1>
    <p style="margin:0 0 20px 0;line-height:1.55;color:#8A90A2;font-size:14px;">Введите этот код в приложении:</p>
    <div style="font-size:32px;font-weight:700;letter-spacing:10px;text-align:center;background:#0B0D16;border:1px solid rgba(242,42,55,0.40);border-radius:14px;padding:18px;font-family:ui-monospace,Menlo,monospace;color:#F5F6F8;">${code}</div>
    <p style="margin:24px 0 12px 0;line-height:1.55;color:#8A90A2;font-size:14px;">Или нажмите на ссылку — мы откроем приложение:</p>
    <p style="margin:0;"><a href="${url}" style="display:inline-block;background:#F22A37;color:#F5F6F8;text-decoration:none;font-weight:600;padding:12px 22px;border-radius:14px;font-size:14px;">Войти в А-ГОЛОС</a></p>
    <hr style="border:none;border-top:1px solid rgba(245,246,248,0.08);margin:32px 0 20px 0;" />
    <p style="font-size:12px;color:#5C616E;margin:0;line-height:1.55;">Код действителен 10 минут. Если вы не запрашивали вход — игнорируйте это письмо.</p>
  </div>
  <p style="text-align:center;font-size:11px;color:#5C616E;margin:24px 0 0 0;letter-spacing:0.4px;">Скажите мысль. Получите текст.</p>
</body></html>`;
}

function renderText({ code, url }: { code: string; url: string }): string {
  return `А-ГОЛОС — код для входа

Код: ${code}

Или откройте ссылку: ${url}

Код действителен 10 минут.
Если вы не запрашивали вход — игнорируйте это письмо.

—
Скажите мысль. Получите текст.`;
}
