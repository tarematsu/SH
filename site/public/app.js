const el = (id) => document.getElementById(id);
const number = (value) => value == null ? "-" : Number(value).toLocaleString("ja-JP");
const date = (value) => value ? new Date(value).toLocaleString("ja-JP") : "-";

function drawChart(rows) {
  const canvas = el("chart");
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  if (!rows.length) return;

  const values = rows.map((row) => Number(row.play_count)).filter(Number.isFinite);
  if (!values.length) return;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = Math.max(1, max - min);
  const pad = 32;

  ctx.strokeStyle = "#8ab4f8";
  ctx.lineWidth = 3;
  ctx.beginPath();
  rows.forEach((row, index) => {
    const value = Number(row.play_count);
    const x = pad + index * (canvas.width - pad * 2) / Math.max(1, rows.length - 1);
    const y = canvas.height - pad - (value - min) * (canvas.height - pad * 2) / range;
    if (index === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  });
  ctx.stroke();
}

async function refresh() {
  const response = await fetch("/api/dashboard", { cache: "no-store" });
  if (!response.ok) throw new Error(`API error: ${response.status}`);
  const data = await response.json();

  el("status").textContent = data.latest?.status ?? "-";
  el("plays").textContent = number(data.latest?.play_count);
  el("commentCount").textContent = number(data.latest?.comment_count);
  el("updated").textContent = date(data.latest?.observed_at);

  const lastTime = data.latest?.observed_at ? new Date(data.latest.observed_at).getTime() : 0;
  const ageMinutes = (Date.now() - lastTime) / 60000;
  const health = el("health");
  health.className = ageMinutes <= 2 ? "status-ok" : ageMinutes <= 5 ? "status-warn" : "status-stop";
  health.textContent = ageMinutes <= 2 ? "監視正常" : ageMinutes <= 5 ? "取得遅延" : "停止の可能性";

  const tbody = el("comments");
  tbody.replaceChildren(...data.comments.map((comment) => {
    const tr = document.createElement("tr");
    for (const text of [date(comment.observed_at), comment.author_name ?? "匿名", comment.comment_text]) {
      const td = document.createElement("td");
      td.textContent = text;
      tr.append(td);
    }
    return tr;
  }));

  drawChart(data.history);
}

refresh().catch((error) => { el("health").textContent = error.message; });
setInterval(() => refresh().catch(console.error), 60_000);