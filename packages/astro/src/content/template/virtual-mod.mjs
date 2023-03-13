// astro-head-inject
import {
	createCollectionToGlobResultMap,
	createGetCollection,
	createGetEntryBySlug,
} from 'astro/content/runtime';

export { z } from 'astro/zod';

export function defineCollection(config) {
	return config;
}

const contentDir = '@@CONTENT_DIR@@';

const entryGlob = import.meta.glob('@@ENTRY_GLOB_PATH@@', {
	query: { astroContent: true },
});
const collectionToEntryMap = createCollectionToGlobResultMap({
	globResult: entryGlob,
	contentDir,
});

const renderEntryGlob = import.meta.glob('@@RENDER_ENTRY_GLOB_PATH@@', {
	query: { astroPropagatedAssets: true },
});
const collectionToRenderEntryMap = createCollectionToGlobResultMap({
	globResult: renderEntryGlob,
	contentDir,
});

export const getCollection = createGetCollection({
	collectionToEntryMap,
	collectionToRenderEntryMap,
});

export const getEntryBySlug = createGetEntryBySlug({
	getCollection,
	collectionToRenderEntryMap,
});
