import fs from 'fs';
import * as colors from 'kleur/colors';
import { bgGreen, black, cyan, dim, green, magenta } from 'kleur/colors';
import type { OutputAsset, OutputChunk } from 'rollup';
import { fileURLToPath } from 'url';
import type {
	AstroConfig,
	AstroMiddlewareInstance,
	AstroSettings,
	ComponentInstance,
	EndpointHandler,
	EndpointOutput,
	ImageTransform,
	MiddlewareResponseHandler,
	RouteType,
	SSRError,
	SSRLoadedRenderer,
} from '../../@types/astro';
import {
	generateImage as generateImageInternal,
	getStaticImageList,
} from '../../assets/generate.js';
import {
	hasPrerenderedPages,
	type BuildInternals,
	eachPageDataFromEntryPoint,
} from '../../core/build/internal.js';
import {
	prependForwardSlash,
	removeLeadingForwardSlash,
	removeTrailingForwardSlash,
} from '../../core/path.js';
import { runHookBuildGenerated } from '../../integrations/index.js';
import { isHybridOutput } from '../../prerender/utils.js';
import { BEFORE_HYDRATION_SCRIPT_ID, PAGE_SCRIPT_ID } from '../../vite-plugin-scripts/index.js';
import { callEndpoint, createAPIContext, throwIfRedirectNotAllowed } from '../endpoint/index.js';
import { AstroError } from '../errors/index.js';
import { debug, info } from '../logger/core.js';
import { callMiddleware } from '../middleware/callMiddleware.js';
import { createEnvironment, createRenderContext, renderPage } from '../render/index.js';
import { callGetStaticPaths } from '../render/route-cache.js';
import {
	createAssetLink,
	createModuleScriptsSet,
	createStylesheetElementSet,
} from '../render/ssr-element.js';
import { createRequest } from '../request.js';
import { matchRoute } from '../routing/match.js';
import { getOutputFilename } from '../util.js';
import { getOutDirWithinCwd, getOutFile, getOutFolder } from './common.js';
import { cssOrder, eachPageData, getPageDataByComponent, mergeInlineCss } from './internal.js';
import type {
	PageBuildData,
	SinglePageBuiltModule,
	StaticBuildOptions,
	StylesheetAsset,
} from './types';
import { getTimeStat } from './util.js';
import { ASTRO_PAGE_MODULE_ID } from './plugins/plugin-pages';

function shouldSkipDraft(pageModule: ComponentInstance, settings: AstroSettings): boolean {
	return (
		// Drafts are disabled
		!settings.config.markdown.drafts &&
		// This is a draft post
		'frontmatter' in pageModule &&
		(pageModule as any).frontmatter?.draft === true
	);
}

// Gives back a facadeId that is relative to the root.
// ie, src/pages/index.astro instead of /Users/name..../src/pages/index.astro
export function rootRelativeFacadeId(facadeId: string, settings: AstroSettings): string {
	return facadeId.slice(fileURLToPath(settings.config.root).length);
}

// Determines of a Rollup chunk is an entrypoint page.
export function chunkIsPage(
	settings: AstroSettings,
	output: OutputAsset | OutputChunk,
	internals: BuildInternals
) {
	if (output.type !== 'chunk') {
		return false;
	}
	const chunk = output as OutputChunk;
	if (chunk.facadeModuleId) {
		const facadeToEntryId = prependForwardSlash(
			rootRelativeFacadeId(chunk.facadeModuleId, settings)
		);
		return internals.entrySpecifierToBundleMap.has(facadeToEntryId);
	}
	return false;
}

export async function generatePages(opts: StaticBuildOptions, internals: BuildInternals) {
	const timer = performance.now();
	const ssr = opts.settings.config.output === 'server' || isHybridOutput(opts.settings.config); // hybrid mode is essentially SSR with prerender by default
	const serverEntry = opts.buildConfig.serverEntry;
	const outFolder = ssr ? opts.buildConfig.server : getOutDirWithinCwd(opts.settings.config.outDir);

	if (ssr && !hasPrerenderedPages(internals)) return;

	const verb = ssr ? 'prerendering' : 'generating';
	info(opts.logging, null, `\n${bgGreen(black(` ${verb} static routes `))}`);

	const builtPaths = new Set<string>();

	if (ssr) {
		for (const [pageData, filePath] of eachPageDataFromEntryPoint(internals)) {
			if (pageData.route.prerender) {
				const ssrEntryURLPage = new URL('./' + filePath + `?time=${Date.now()}`, outFolder);
				const ssrEntryPage = await import(ssrEntryURLPage.toString());

				await generatePage(opts, internals, pageData, ssrEntryPage, builtPaths);
			}
		}
	} else {
		for (const [pageData, filePath] of eachPageDataFromEntryPoint(internals)) {
			const ssrEntryURLPage = new URL('./' + filePath + `?time=${Date.now()}`, outFolder);
			const ssrEntryPage = await import(ssrEntryURLPage.toString());

			await generatePage(opts, internals, pageData, ssrEntryPage, builtPaths);
		}
	}

	if (opts.settings.config.experimental.assets) {
		info(opts.logging, null, `\n${bgGreen(black(` generating optimized images `))}`);
		for (const imageData of getStaticImageList()) {
			await generateImage(opts, imageData[1].options, imageData[1].path);
		}

		delete globalThis.astroAsset.addStaticImage;
	}

	await runHookBuildGenerated({
		config: opts.settings.config,
		buildConfig: opts.buildConfig,
		logging: opts.logging,
	});

	info(opts.logging, null, dim(`Completed in ${getTimeStat(timer, performance.now())}.\n`));
}

async function generateImage(opts: StaticBuildOptions, transform: ImageTransform, path: string) {
	let timeStart = performance.now();
	const generationData = await generateImageInternal(opts, transform, path);

	if (!generationData) {
		return;
	}

	const timeEnd = performance.now();
	const timeChange = getTimeStat(timeStart, timeEnd);
	const timeIncrease = `(+${timeChange})`;
	const statsText = generationData.cached
		? `(reused cache entry)`
		: `(before: ${generationData.weight.before}kb, after: ${generationData.weight.after}kb)`;
	info(opts.logging, null, `  ${green('▶')} ${path} ${dim(statsText)} ${dim(timeIncrease)}`);
}

async function generatePage(
	opts: StaticBuildOptions,
	internals: BuildInternals,
	pageData: PageBuildData,
	ssrEntry: SinglePageBuiltModule,
	builtPaths: Set<string>
) {
	let timeStart = performance.now();
	const renderers = ssrEntry.renderers;

	const pageInfo = getPageDataByComponent(internals, pageData.route.component);

	// may be used in the future for handling rel=modulepreload, rel=icon, rel=manifest etc.
	const linkIds: [] = [];
	const scripts = pageInfo?.hoistedScript ?? null;
	const styles = pageData.styles
		.sort(cssOrder)
		.map(({ sheet }) => sheet)
		.reduce(mergeInlineCss, []);

	const pageModulePromise = ssrEntry.page;
	const middleware = ssrEntry.middleware;

	if (!pageModulePromise) {
		throw new Error(
			`Unable to find the module for ${pageData.component}. This is unexpected and likely a bug in Astro, please report.`
		);
	}
	const pageModule = await pageModulePromise();
	if (shouldSkipDraft(pageModule, opts.settings)) {
		info(opts.logging, null, `${magenta('⚠️')}  Skipping draft ${pageData.route.component}`);
		return;
	}

	const generationOptions: Readonly<GeneratePathOptions> = {
		pageData,
		internals,
		linkIds,
		scripts,
		styles,
		mod: pageModule,
		renderers,
	};

	const icon = pageData.route.type === 'page' ? green('▶') : magenta('λ');
	info(opts.logging, null, `${icon} ${pageData.route.component}`);

	// Get paths for the route, calling getStaticPaths if needed.
	const paths = await getPathsForRoute(pageData, pageModule, opts, builtPaths);

	for (let i = 0; i < paths.length; i++) {
		const path = paths[i];
		await generatePath(path, opts, generationOptions, middleware);
		const timeEnd = performance.now();
		const timeChange = getTimeStat(timeStart, timeEnd);
		const timeIncrease = `(+${timeChange})`;
		const filePath = getOutputFilename(opts.settings.config, path, pageData.route.type);
		const lineIcon = i === paths.length - 1 ? '└─' : '├─';
		info(opts.logging, null, `  ${cyan(lineIcon)} ${dim(filePath)} ${dim(timeIncrease)}`);
	}
}

async function getPathsForRoute(
	pageData: PageBuildData,
	mod: ComponentInstance,
	opts: StaticBuildOptions,
	builtPaths: Set<string>
): Promise<Array<string>> {
	let paths: Array<string> = [];
	if (pageData.route.pathname) {
		paths.push(pageData.route.pathname);
		builtPaths.add(pageData.route.pathname);
	} else {
		const route = pageData.route;
		const result = await callGetStaticPaths({
			mod,
			route: pageData.route,
			isValidate: false,
			logging: opts.logging,
			ssr: opts.settings.config.output === 'server' || isHybridOutput(opts.settings.config),
		})
			.then((_result) => {
				const label = _result.staticPaths.length === 1 ? 'page' : 'pages';
				debug(
					'build',
					`├── ${colors.bold(colors.green('✔'))} ${route.component} → ${colors.magenta(
						`[${_result.staticPaths.length} ${label}]`
					)}`
				);
				return _result;
			})
			.catch((err) => {
				debug('build', `├── ${colors.bold(colors.red('✗'))} ${route.component}`);
				throw err;
			});

		// Save the route cache so it doesn't get called again
		opts.routeCache.set(route, result);

		paths = result.staticPaths
			.map((staticPath) => staticPath.params && route.generate(staticPath.params))
			.filter((staticPath) => {
				// The path hasn't been built yet, include it
				if (!builtPaths.has(removeTrailingForwardSlash(staticPath))) {
					return true;
				}

				// The path was already built once. Check the manifest to see if
				// this route takes priority for the final URL.
				// NOTE: The same URL may match multiple routes in the manifest.
				// Routing priority needs to be verified here for any duplicate
				// paths to ensure routing priority rules are enforced in the final build.
				const matchedRoute = matchRoute(staticPath, opts.manifest);
				return matchedRoute === route;
			});

		// Add each path to the builtPaths set, to avoid building it again later.
		for (const staticPath of paths) {
			builtPaths.add(removeTrailingForwardSlash(staticPath));
		}
	}

	return paths;
}

interface GeneratePathOptions {
	pageData: PageBuildData;
	internals: BuildInternals;
	linkIds: string[];
	scripts: { type: 'inline' | 'external'; value: string } | null;
	styles: StylesheetAsset[];
	mod: ComponentInstance;
	renderers: SSRLoadedRenderer[];
}

function shouldAppendForwardSlash(
	trailingSlash: AstroConfig['trailingSlash'],
	buildFormat: AstroConfig['build']['format']
): boolean {
	switch (trailingSlash) {
		case 'always':
			return true;
		case 'never':
			return false;
		case 'ignore': {
			switch (buildFormat) {
				case 'directory':
					return true;
				case 'file':
					return false;
			}
		}
	}
}

function addPageName(pathname: string, opts: StaticBuildOptions): void {
	const trailingSlash = opts.settings.config.trailingSlash;
	const buildFormat = opts.settings.config.build.format;
	const pageName = shouldAppendForwardSlash(trailingSlash, buildFormat)
		? pathname.replace(/\/?$/, '/').replace(/^\//, '')
		: pathname.replace(/^\//, '');
	opts.pageNames.push(pageName);
}

function getUrlForPath(
	pathname: string,
	base: string,
	origin: string,
	format: 'directory' | 'file',
	routeType: RouteType
): URL {
	/**
	 * Examples:
	 * pathname: /, /foo
	 * base: /
	 */
	const ending = format === 'directory' ? '/' : '.html';
	let buildPathname: string;
	if (pathname === '/' || pathname === '') {
		buildPathname = base;
	} else if (routeType === 'endpoint') {
		const buildPathRelative = removeLeadingForwardSlash(pathname);
		buildPathname = base + buildPathRelative;
	} else {
		const buildPathRelative =
			removeTrailingForwardSlash(removeLeadingForwardSlash(pathname)) + ending;
		buildPathname = base + buildPathRelative;
	}
	const url = new URL(buildPathname, origin);
	return url;
}

async function generatePath(
	pathname: string,
	opts: StaticBuildOptions,
	gopts: GeneratePathOptions,
	middleware?: AstroMiddlewareInstance<unknown>
) {
	const { settings, logging, origin, routeCache } = opts;
	const {
		mod,
		internals,
		linkIds,
		scripts: hoistedScripts,
		styles: _styles,
		pageData,
		renderers,
	} = gopts;

	// This adds the page name to the array so it can be shown as part of stats.
	if (pageData.route.type === 'page') {
		addPageName(pathname, opts);
	}

	debug('build', `Generating: ${pathname}`);

	// may be used in the future for handling rel=modulepreload, rel=icon, rel=manifest etc.
	const links = new Set<never>();
	const scripts = createModuleScriptsSet(
		hoistedScripts ? [hoistedScripts] : [],
		settings.config.base,
		settings.config.build.assetsPrefix
	);
	const styles = createStylesheetElementSet(
		_styles,
		settings.config.base,
		settings.config.build.assetsPrefix
	);

	if (settings.scripts.some((script) => script.stage === 'page')) {
		const hashedFilePath = internals.entrySpecifierToBundleMap.get(PAGE_SCRIPT_ID);
		if (typeof hashedFilePath !== 'string') {
			throw new Error(`Cannot find the built path for ${PAGE_SCRIPT_ID}`);
		}
		const src = createAssetLink(
			hashedFilePath,
			settings.config.base,
			settings.config.build.assetsPrefix
		);
		scripts.add({
			props: { type: 'module', src },
			children: '',
		});
	}

	// Add all injected scripts to the page.
	for (const script of settings.scripts) {
		if (script.stage === 'head-inline') {
			scripts.add({
				props: {},
				children: script.content,
			});
		}
	}

	const ssr = settings.config.output === 'server' || isHybridOutput(settings.config);
	const url = getUrlForPath(
		pathname,
		opts.settings.config.base,
		origin,
		opts.settings.config.build.format,
		pageData.route.type
	);
	const env = createEnvironment({
		adapterName: undefined,
		logging,
		markdown: settings.config.markdown,
		mode: opts.mode,
		renderers,
		clientDirectives: settings.clientDirectives,
		async resolve(specifier: string) {
			const hashedFilePath = internals.entrySpecifierToBundleMap.get(specifier);
			if (typeof hashedFilePath !== 'string') {
				// If no "astro:scripts/before-hydration.js" script exists in the build,
				// then we can assume that no before-hydration scripts are needed.
				if (specifier === BEFORE_HYDRATION_SCRIPT_ID) {
					return '';
				}
				throw new Error(`Cannot find the built path for ${specifier}`);
			}
			return createAssetLink(
				hashedFilePath,
				settings.config.base,
				settings.config.build.assetsPrefix
			);
		},
		routeCache,
		site: settings.config.site
			? new URL(settings.config.base, settings.config.site).toString()
			: settings.config.site,
		ssr,
		streaming: true,
	});

	const renderContext = await createRenderContext({
		origin,
		pathname,
		request: createRequest({ url, headers: new Headers(), logging, ssr }),
		componentMetadata: internals.componentMetadata,
		scripts,
		styles,
		links,
		route: pageData.route,
		env,
		mod,
	});

	let body: string | Uint8Array;
	let encoding: BufferEncoding | undefined;
	if (pageData.route.type === 'endpoint') {
		const endpointHandler = mod as unknown as EndpointHandler;

		const result = await callEndpoint(
			endpointHandler,
			env,
			renderContext,
			logging,
			middleware as AstroMiddlewareInstance<Response | EndpointOutput>
		);

		if (result.type === 'response') {
			throwIfRedirectNotAllowed(result.response, opts.settings.config);
			// If there's no body, do nothing
			if (!result.response.body) return;
			const ab = await result.response.arrayBuffer();
			body = new Uint8Array(ab);
		} else {
			body = result.body;
			encoding = result.encoding;
		}
	} else {
		let response: Response;
		try {
			const apiContext = createAPIContext({
				request: renderContext.request,
				params: renderContext.params,
				props: renderContext.props,
				site: env.site,
				adapterName: env.adapterName,
			});

			const onRequest = middleware?.onRequest;
			if (onRequest) {
				response = await callMiddleware<Response>(
					env.logging,
					onRequest as MiddlewareResponseHandler,
					apiContext,
					() => {
						return renderPage({ mod, renderContext, env, apiContext });
					}
				);
			} else {
				response = await renderPage({ mod, renderContext, env, apiContext });
			}
		} catch (err) {
			if (!AstroError.is(err) && !(err as SSRError).id && typeof err === 'object') {
				(err as SSRError).id = pageData.component;
			}
			throw err;
		}
		throwIfRedirectNotAllowed(response, opts.settings.config);
		// If there's no body, do nothing
		if (!response.body) return;
		body = await response.text();
	}

	const outFolder = getOutFolder(settings.config, pathname, pageData.route.type);
	const outFile = getOutFile(settings.config, outFolder, pathname, pageData.route.type);
	pageData.route.distURL = outFile;
	await fs.promises.mkdir(outFolder, { recursive: true });
	await fs.promises.writeFile(outFile, body, encoding ?? 'utf-8');
}
