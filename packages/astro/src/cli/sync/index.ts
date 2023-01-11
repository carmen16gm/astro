import { dim } from 'kleur/colors';
import type fsMod from 'node:fs';
import { performance } from 'node:perf_hooks';
import type { AstroSettings } from '../../@types/astro';
import { contentObservable, createContentTypesGenerator } from '../../content/index.js';
import { getTimeStat } from '../../core/build/util.js';
import { AstroError, AstroErrorData } from '../../core/errors/index.js';
import { info, LogOptions } from '../../core/logger/core.js';
import { setUpEnvTs } from '../../vite-plugin-inject-env-ts/index.js';

export async function sync(
	settings: AstroSettings,
	{ logging, fs }: { logging: LogOptions; fs: typeof fsMod }
): Promise<0 | 1> {
	const timerStart = performance.now();

	try {
		const contentTypesGenerator = await createContentTypesGenerator({
			contentConfigObserver: contentObservable({ status: 'loading' }),
			logging,
			fs,
			settings,
		});
		const typesResult = await contentTypesGenerator.init();
		if (typesResult.typesGenerated === false) {
			switch (typesResult.reason) {
				case 'no-content-dir':
				default:
					info(logging, 'content', 'No content directory found. Skipping type generation.');
					return 0;
			}
		}
	} catch (e) {
		throw new AstroError(AstroErrorData.GenerateContentTypesError);
	}

	info(logging, 'content', `Types generated ${dim(getTimeStat(timerStart, performance.now()))}`);
	await setUpEnvTs({ settings, logging, fs });

	return 0;
}
