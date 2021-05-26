import type { GetHydrateCallback } from '../../@types/hydrate';

/**
 * Hydrate this component immediately
 */
export default async function onLoad(astroId: string, getHydrateCallback: GetHydrateCallback) {
  const roots = document.querySelectorAll(`astro-root[uid="${astroId}"]`);
  const innerHTML = roots[0].querySelector(`astro-fragment`)?.innerHTML ?? null;
  const hydrate = await getHydrateCallback();

  for (const root of roots) {
    hydrate(root, innerHTML);
  }
}
