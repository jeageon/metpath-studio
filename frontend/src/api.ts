import type { PathwayResponse } from './types';

export async function fetchPathway(pathwayId: string, hideCofactors = false): Promise<PathwayResponse> {
  const params = new URLSearchParams();
  if (hideCofactors) {
    params.set('hide_cofactors', 'true');
  }

  const query = params.toString();
  const endpoint = `/api/pathway/${encodeURIComponent(pathwayId)}${query ? `?${query}` : ''}`;

  const response = await fetch(endpoint);
  if (!response.ok) {
    const message = await response.text();
    throw new Error(message || `Failed to fetch pathway ${pathwayId}`);
  }
  return response.json();
}

export async function importSbml(file: File): Promise<PathwayResponse> {
  const form = new FormData();
  form.append('file', file);

  const response = await fetch('/api/import/sbml', {
    method: 'POST',
    body: form,
  });
  if (!response.ok) {
    const message = await response.text();
    throw new Error(message || 'Failed to import SBML file');
  }
  return response.json();
}
