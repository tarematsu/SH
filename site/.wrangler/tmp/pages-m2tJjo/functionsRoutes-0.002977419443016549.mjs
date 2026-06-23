import { onRequestGet as __api_dashboard_js_onRequestGet } from "C:\\Users\\yuuki\\Documents\\stationhead-monitor\\site\\functions\\api\\dashboard.js"
import { onRequestGet as __api_health_js_onRequestGet } from "C:\\Users\\yuuki\\Documents\\stationhead-monitor\\site\\functions\\api\\health.js"
import { onRequestPost as __api_ingest_js_onRequestPost } from "C:\\Users\\yuuki\\Documents\\stationhead-monitor\\site\\functions\\api\\ingest.js"

export const routes = [
    {
      routePath: "/api/dashboard",
      mountPath: "/api",
      method: "GET",
      middlewares: [],
      modules: [__api_dashboard_js_onRequestGet],
    },
  {
      routePath: "/api/health",
      mountPath: "/api",
      method: "GET",
      middlewares: [],
      modules: [__api_health_js_onRequestGet],
    },
  {
      routePath: "/api/ingest",
      mountPath: "/api",
      method: "POST",
      middlewares: [],
      modules: [__api_ingest_js_onRequestPost],
    },
  ]