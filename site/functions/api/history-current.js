import { compatibilityRedirect } from '../lib/api-compatibility.js';

export async function onRequestGet({ request }) {
  return compatibilityRedirect(request, '/api/minute-facts/current');
}
