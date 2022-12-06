import type { SSRResult } from '../../../@types/astro';

import { markHTMLString } from '../escape.js';
import { renderChild } from './any.js';
import { renderElement } from './util.js';

// Filter out duplicate elements in our set
const uniqueElements = (item: any, index: number, all: any[]) => {
	const props = JSON.stringify(item.props);
	const children = item.children;
	return (
		index === all.findIndex((i) => JSON.stringify(i.props) === props && i.children == children)
	);
};

async function* renderExtraHead(result: SSRResult, base: string) {
	yield base;
	for (const part of result.extraHead) {
		yield* renderChild(part);
	}
}

function renderAllHeadContent(result: SSRResult) {
	const styles = Array.from(result.styles)
		.filter(uniqueElements)
		.map((style) => renderElement('style', style));
	// Clear result.styles so that any new styles added will be inlined.
	result.styles.clear();
	const scripts = Array.from(result.scripts)
		.filter(uniqueElements)
		.map((script, i) => {
			return renderElement('script', script, false);
		});
	const links = Array.from(result.links)
		.filter(uniqueElements)
		.map((link) => renderElement('link', link, false));

	const baseHeadContent = markHTMLString(links.join('\n') + styles.join('\n') + scripts.join('\n'));

	if (result.extraHead.length > 0) {
		return renderExtraHead(result, baseHeadContent);
	} else {
		return baseHeadContent;
	}
}

export function createRenderHead(result: SSRResult) {
	result._metadata.hasRenderedHead = true;
	return renderAllHeadContent.bind(null, result);
}

export const renderHead = createRenderHead;

// This function is called by Astro components that do not contain a <head> component
// This accommodates the fact that using a <head> is optional in Astro, so this
// is called before a component's first non-head HTML element. If the head was
// already injected it is a noop.
export async function* maybeRenderHead(result: SSRResult) {
	if (result._metadata.hasRenderedHead) {
		return;
	}
	yield createRenderHead(result)();
}
