import fs from 'node:fs';
import { bold } from 'kleur/colors';
import type { AddressInfo } from 'net';
import { fileURLToPath } from 'node:url';
import type { InlineConfig, ViteDevServer } from 'vite';
import {
	AstroConfig,
	AstroIntegration,
	AstroRenderer,
	AstroSettings,
	BuildConfig,
	HookParameters,
	RouteData,
} from '../@types/astro.js';
import type { SerializedSSRManifest } from '../core/app/types';
import type { PageBuildData } from '../core/build/types';
import { mergeConfig } from '../core/config/config.js';
import { info, LogOptions, warn } from '../core/logger/core.js';

async function withTakingALongTimeMsg<T>({
	name,
	hookResult,
	timeoutMs = 3000,
	logging,
}: {
	name: string;
	hookResult: T | Promise<T>;
	timeoutMs?: number;
	logging: LogOptions;
}): Promise<T> {
	const timeout = setTimeout(() => {
		info(logging, 'build', `Waiting for the ${bold(name)} integration...`);
	}, timeoutMs);
	const result = await hookResult;
	clearTimeout(timeout);
	return result;
}

export async function runHookConfigSetup({
	settings,
	command,
	logging,
	isRestart = false,
}: {
	settings: AstroSettings;
	command: 'dev' | 'build' | 'preview';
	logging: LogOptions;
	isRestart?: boolean;
}): Promise<AstroSettings> {
	// An adapter is an integration, so if one is provided push it.
	if (settings.config.adapter) {
		settings.config.integrations.push(settings.config.adapter);
	}

	let updatedConfig: AstroConfig = { ...settings.config };
	let updatedSettings: AstroSettings = { ...settings, config: updatedConfig };
	for (const integration of settings.config.integrations) {
		/**
		 * By making integration hooks optional, Astro can now ignore null or undefined Integrations
		 * instead of giving an internal error most people can't read
		 *
		 * This also enables optional integrations, e.g.
		 * ```ts
		 * integration: [
		 *   // Only run `compress` integration in production environments, etc...
		 *   import.meta.env.production ? compress() : null
		 * ]
		 * ```
		 */
		if (integration?.hooks?.['astro:config:setup']) {
			const hooks: HookParameters<'astro:config:setup'> = {
				config: updatedConfig,
				command,
				isRestart,
				addRenderer(renderer: AstroRenderer) {
					if (!renderer.name) {
						throw new Error(`Integration ${bold(integration.name)} has an unnamed renderer.`);
					}

					if (!renderer.serverEntrypoint) {
						throw new Error(`Renderer ${bold(renderer.name)} does not provide a serverEntrypoint.`);
					}

					updatedSettings.renderers.push(renderer);
				},
				injectScript: (stage, content) => {
					updatedSettings.scripts.push({ stage, content });
				},
				updateConfig: (newConfig) => {
					updatedConfig = mergeConfig(updatedConfig, newConfig) as AstroConfig;
				},
				injectRoute: (injectRoute) => {
					updatedSettings.injectedRoutes.push(injectRoute);
				},
				addWatchFile: (path) => {
					updatedSettings.watchFiles.push(path instanceof URL ? fileURLToPath(path) : path);
				},
			};
			// Semi-private `addPageExtension` hook
			function addPageExtension(...input: (string | string[])[]) {
				const exts = (input.flat(Infinity) as string[]).map((ext) => `.${ext.replace(/^\./, '')}`);
				updatedSettings.pageExtensions.push(...exts);
			}
			Object.defineProperty(hooks, 'addPageExtension', {
				value: addPageExtension,
				writable: false,
				enumerable: false,
			});
			await withTakingALongTimeMsg({
				name: integration.name,
				hookResult: integration.hooks['astro:config:setup'](hooks),
				logging,
			});
		}
	}

	updatedSettings.config = updatedConfig;
	return updatedSettings;
}

export async function runHookConfigDone({
	settings,
	logging,
}: {
	settings: AstroSettings;
	logging: LogOptions;
}) {
	for (const integration of settings.config.integrations) {
		if (integration?.hooks?.['astro:config:done']) {
			await withTakingALongTimeMsg({
				name: integration.name,
				hookResult: integration.hooks['astro:config:done']({
					config: settings.config,
					setAdapter(adapter) {
						if (settings.adapter && settings.adapter.name !== adapter.name) {
							throw new Error(
								`Integration "${integration.name}" conflicts with "${settings.adapter.name}". You can only configure one deployment integration.`
							);
						}
						settings.adapter = adapter;
					},
				}),
				logging,
			});
		}
	}
}

export async function runHookServerSetup({
	config,
	server,
	logging,
}: {
	config: AstroConfig;
	server: ViteDevServer;
	logging: LogOptions;
}) {
	for (const integration of config.integrations) {
		if (integration?.hooks?.['astro:server:setup']) {
			await withTakingALongTimeMsg({
				name: integration.name,
				hookResult: integration.hooks['astro:server:setup']({ server }),
				logging,
			});
		}
	}
}

export async function runHookServerStart({
	config,
	address,
	logging,
}: {
	config: AstroConfig;
	address: AddressInfo;
	logging: LogOptions;
}) {
	for (const integration of config.integrations) {
		if (integration?.hooks?.['astro:server:start']) {
			await withTakingALongTimeMsg({
				name: integration.name,
				hookResult: integration.hooks['astro:server:start']({ address }),
				logging,
			});
		}
	}
}

export async function runHookServerDone({
	config,
	logging,
}: {
	config: AstroConfig;
	logging: LogOptions;
}) {
	for (const integration of config.integrations) {
		if (integration?.hooks?.['astro:server:done']) {
			await withTakingALongTimeMsg({
				name: integration.name,
				hookResult: integration.hooks['astro:server:done'](),
				logging,
			});
		}
	}
}

export async function runHookBuildStart({
	config,
	buildConfig,
	logging,
}: {
	config: AstroConfig;
	buildConfig: BuildConfig;
	logging: LogOptions;
}) {
	function warnDeprecated(
		integration: AstroIntegration,
		prop: 'server' | 'client' | 'serverEntry'
	) {
		let value: any = Reflect.get(buildConfig, prop);
		Object.defineProperty(buildConfig, prop, {
			enumerable: true,
			get() {
				return value;
			},
			set(newValue) {
				value = newValue;
				warn(
					logging,
					'astro:build:start',
					`Your adapter ${bold(integration.name)} is using a deprecated API, buildConfig. ${bold(
						prop
					)} config should be set via config.build.${prop} instead.`
				);
			},
		});
		return () => {
			Object.defineProperty(buildConfig, prop, {
				enumerable: true,
				value,
			});
		};
	}

	for (const integration of config.integrations) {
		if (integration?.hooks?.['astro:build:start']) {
			const undoClientWarning = warnDeprecated(integration, 'client');
			const undoServerWarning = warnDeprecated(integration, 'server');
			const undoServerEntryWarning = warnDeprecated(integration, 'serverEntry');
			await withTakingALongTimeMsg({
				name: integration.name,
				hookResult: integration.hooks['astro:build:start']({ buildConfig }),
				logging,
			});
			undoClientWarning();
			undoServerEntryWarning();
			undoServerWarning();
		}
	}
}

export async function runHookBuildSetup({
	config,
	vite,
	pages,
	target,
	logging,
}: {
	config: AstroConfig;
	vite: InlineConfig;
	pages: Map<string, PageBuildData>;
	target: 'server' | 'client';
	logging: LogOptions;
}) {
	for (const integration of config.integrations) {
		if (integration?.hooks?.['astro:build:setup']) {
			await withTakingALongTimeMsg({
				name: integration.name,
				hookResult: integration.hooks['astro:build:setup']({
					vite,
					pages,
					target,
					updateConfig: (newConfig) => {
						mergeConfig(vite, newConfig);
					},
				}),
				logging,
			});
		}
	}
}

export async function runHookBuildSsr({
	config,
	manifest,
	logging,
}: {
	config: AstroConfig;
	manifest: SerializedSSRManifest;
	logging: LogOptions;
}) {
	for (const integration of config.integrations) {
		if (integration?.hooks?.['astro:build:ssr']) {
			await withTakingALongTimeMsg({
				name: integration.name,
				hookResult: integration.hooks['astro:build:ssr']({ manifest }),
				logging,
			});
		}
	}
}

export async function runHookBuildGenerated({
	config,
	buildConfig,
	logging,
}: {
	config: AstroConfig;
	buildConfig: BuildConfig;
	logging: LogOptions;
}) {
	const dir = config.output === 'server' ? buildConfig.client : config.outDir;

	for (const integration of config.integrations) {
		if (integration?.hooks?.['astro:build:generated']) {
			await withTakingALongTimeMsg({
				name: integration.name,
				hookResult: integration.hooks['astro:build:generated']({ dir }),
				logging,
			});
		}
	}
}

export async function runHookBuildDone({
	config,
	buildConfig,
	pages,
	routes,
	logging,
}: {
	config: AstroConfig;
	buildConfig: BuildConfig;
	pages: string[];
	routes: RouteData[];
	logging: LogOptions;
}) {
	const dir = config.output === 'server' ? buildConfig.client : config.outDir;
	await fs.promises.mkdir(dir, { recursive: true });

	for (const integration of config.integrations) {
		if (integration?.hooks?.['astro:build:done']) {
			await withTakingALongTimeMsg({
				name: integration.name,
				hookResult: integration.hooks['astro:build:done']({
					pages: pages.map((p) => ({ pathname: p })),
					dir,
					routes,
				}),
				logging,
			});
		}
	}
}
