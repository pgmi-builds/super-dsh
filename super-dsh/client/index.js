window.__ModuleLoader__.load({ id: "super-dsh", factory: (require) => {
var module = { exports: {} }; var exports = module.exports;
//#region rolldown:runtime
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __copyProps = (to, from, except, desc) => {
	if (from && typeof from === "object" || typeof from === "function") for (var keys = __getOwnPropNames(from), i = 0, n = keys.length, key; i < n; i++) {
		key = keys[i];
		if (!__hasOwnProp.call(to, key) && key !== except) __defProp(to, key, {
			get: ((k) => from[k]).bind(null, key),
			enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable
		});
	}
	return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", {
	value: mod,
	enumerable: true
}) : target, mod));

//#endregion
let react = require("react");
react = __toESM(react);
let react_jsx_runtime = require("react/jsx-runtime");
react_jsx_runtime = __toESM(react_jsx_runtime);

//#region src/client/glyph.tsx
/**
* The Hub mark: the Agent Teams icon — four quadrant blocks meeting at the
* center (one per agent, converging into a team), matching the artwork the
* native Plugins page shows for the Agent Teams official bundle. Redrawn
* in-bundle because the client bundle's purity gate forbids value imports
* outside CLIENT_EXTERNALS. The gradient id is unique per instance so repeated
* marks in one document keep distinct `url(#…)` references.
*
* @module superd-hub/client/glyph
*/
/** Sanitized useId: raw React ids contain colons, kept out of url(#…) refs. */
function useGlyphId$1() {
	return `superd_hub_glyph_${react.useId().replaceAll(":", "")}`;
}
/**
* Render the Hub mark.
*
* @param props - `size`: square edge in pixels.
* @returns the inline SVG mark.
*/
function HubGlyph({ size }) {
	const uid = useGlyphId$1();
	return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("svg", {
		width: size,
		height: size,
		viewBox: "8.63 8.17 18.84 18.84",
		fill: "none",
		xmlns: "http://www.w3.org/2000/svg",
		"aria-hidden": "true",
		style: {
			display: "block",
			flex: "none"
		},
		children: [
			/* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", {
				d: "M13.3027 17.1077H9.03125V12.8372H13.3027V17.1077ZM17.5742 12.8372C17.574 15.1958 15.6623 17.1075 13.3037 17.1077V8.56567H17.5742V12.8372Z",
				fill: `url(#${uid}a)`
			}),
			/* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", {
				d: "M18.5229 12.8372V8.56567H22.7944V12.8372H27.0659V17.1077H22.7944C20.4357 17.1077 18.5232 15.1959 18.5229 12.8372Z",
				fill: "#F2AF63"
			}),
			/* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", {
				d: "M17.5742 26.6072H13.3037V18.0642C15.6625 18.0644 17.5742 19.9769 17.5742 22.3357V26.6072ZM13.3027 22.3357H9.03125V18.0642H13.3027V22.3357Z",
				fill: "#7CB7FF"
			}),
			/* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", {
				d: "M22.7944 26.6072H18.5229V22.3357C18.5229 19.9768 20.4355 18.0642 22.7944 18.0642H27.0659V22.3357H22.7944V26.6072Z",
				fill: "#45D9E7"
			}),
			/* @__PURE__ */ (0, react_jsx_runtime.jsx)("defs", { children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("linearGradient", {
				id: `${uid}a`,
				x1: "16.1247",
				y1: "6.6613",
				x2: "9.03125",
				y2: "19.2206",
				gradientUnits: "userSpaceOnUse",
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("stop", { stopColor: "#7CB7FF" }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("stop", {
					offset: "1",
					stopColor: "#145AF3"
				})]
			}) })
		]
	});
}

//#endregion
//#region src/client/runtime-icons.tsx
/**
* Per-runtime marks for the Agent Runtimes roster. Native carries the DSH
* blue fish (the official website mark — the FishLogo geometry at the site's
* #4D6BFE, redrawn in-bundle so no scheme detection is needed); the foreign
* runtimes carry the curated agent-icon pack; any runtime whose key matches
* no asset falls back to the subagent artwork (two stacked rounded squares —
* the native Plugins page's stand-in for subagents) as the default
* foreign-agent mark.
*
* @module superd-hub/client/runtime-icons
*/
/** Curated per-runtime assets, base64 data URIs keyed by roster key. */
const RUNTIME_ICON_URIS = {
	claude: `data:image/svg+xml;base64,PHN2ZyBoZWlnaHQ9IjY0IiB3aWR0aD0iNjQiIHZpZXdCb3g9IjAgMCAyNCAyNCIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj48cGF0aCBkPSJNNC43MDkgMTUuOTU1bDQuNzItMi42NDcuMDgtLjIzLS4wOC0uMTI4SDkuMmwtLjc5LS4wNDgtMi42OTgtLjA3My0yLjMzOS0uMDk3LTIuMjY2LS4xMjItLjU3MS0uMTIxTDAgMTEuNzg0bC4wNTUtLjM1Mi40OC0uMzIxLjY4Ni4wNiAxLjUyLjEwMyAyLjI3OC4xNTggMS42NTIuMDk3IDIuNDQ5LjI1NWguMzg5bC4wNTUtLjE1Ny0uMTM0LS4wOTgtLjEwMy0uMDk3LTIuMzU4LTEuNTk2LTIuNTUyLTEuNjg4LTEuMzM2LS45NzItLjcyNC0uNDkxLS4zNjQtLjQ2Mi0uMTU4LTEuMDA4LjY1Ni0uNzIyLjg4MS4wNi4yMjUuMDYxLjg5My42ODYgMS45MDggMS40NzYgMi40OTEgMS44MzMuMzY1LjMwNC4xNDUtLjEwMy4wMTktLjA3My0uMTY0LS4yNzQtMS4zNTUtMi40NDYtMS40NDYtMi40OS0uNjQ0LTEuMDMyLS4xNy0uNjE5YTIuOTcgMi45NyAwIDAxLS4xMDQtLjcyOUw2LjI4My4xMzQgNi42OTYgMGwuOTk2LjEzNC40Mi4zNjQuNjIgMS40MTQgMS4wMDIgMi4yMjkgMS41NTUgMy4wMy40NTYuODk4LjI0My44MzIuMDkxLjI1NWguMTU4VjkuMDFsLjEyOC0xLjcwNi4yMzctMi4wOTUuMjMtMi42OTUuMDgtLjc2LjM3Ni0uOTEuNzQ3LS40OTIuNTg0LjI4LjQ4LjY4NS0uMDY3LjQ0NC0uMjg2IDEuODUxLS41NTkgMi45MDMtLjM2NCAxLjk0MmguMjEybC4yNDMtLjI0Mi45ODUtMS4zMDYgMS42NTItMi4wNjQuNzMtLjgyLjg1LS45MDQuNTQ3LS40MzFoMS4wMzNsLjc2IDEuMTI5LS4zNCAxLjE2Ni0xLjA2NCAxLjM0Ny0uODgxIDEuMTQyLTEuMjY0IDEuNy0uNzkgMS4zNi4wNzMuMTEuMTg4LS4wMiAyLjg1Ni0uNjA2IDEuNTQzLS4yOCAxLjg0MS0uMzE1LjgzMy4zODguMDkxLjM5NS0uMzI4LjgwNy0xLjk2OS40ODYtMi4zMDkuNDYyLTMuNDM5LjgxMy0uMDQyLjAzLjA0OS4wNjEgMS41NDkuMTQ2LjY2Mi4wMzZoMS42MjJsMy4wMi4yMjUuNzkuNTIyLjQ3NC42MzgtLjA3OS40ODUtMS4yMTUuNjItMS42NC0uMzg5LTMuODI5LS45MS0xLjMxMi0uMzI5aC0uMTgydi4xMWwxLjA5MyAxLjA2OCAyLjAwNiAxLjgxIDIuNTA5IDIuMzMuMTI3LjU3OC0uMzIyLjQ1NS0uMzQtLjA0OS0yLjIwNS0xLjY1Ny0uODUxLS43NDctMS45MjYtMS42MmgtLjEyOHYuMTdsLjQ0NC42NDkgMi4zNDUgMy41MjEuMTIyIDEuMDgtLjE3LjM1My0uNjA4LjIxMy0uNjY4LS4xMjItMS4zNzQtMS45MjUtMS40MTUtMi4xNjctMS4xNDMtMS45NDMtLjE0LjA4LS42NzQgNy4yNTQtLjMxNi4zNy0uNzI5LjI4LS42MDctLjQ2MS0uMzIyLS43NDcuMzIyLTEuNDc2LjM4OS0xLjkyNC4zMTUtMS41My4yODYtMS45LjE3LS42MzItLjAxMi0uMDQyLS4xNC4wMTgtMS40MzQgMS45NjctMi4xOCAyLjk0NS0xLjcyNiAxLjg0NS0uNDE0LjE2NC0uNzE3LS4zNy4wNjctLjY2Mi40MDEtLjU4OSAyLjM4OC0zLjAzNiAxLjQ0LTEuODgyLjkzLTEuMDg2LS4wMDYtLjE1OGgtLjA1NUw0LjEzMiAxOC41NmwtMS4xMy4xNDYtLjQ4Ny0uNDU2LjA2MS0uNzQ2LjIzMS0uMjQzIDEuOTA4LTEuMzEyLS4wMDYuMDA2eiIgZmlsbD0iI0Q5Nzc1NyIgZmlsbC1ydWxlPSJub256ZXJvIi8+PC9zdmc+Cg==`,
	codex: `data:image/svg+xml;base64,PHN2ZyBmaWxsPSJjdXJyZW50Q29sb3IiIGZpbGwtcnVsZT0iZXZlbm9kZCIgaGVpZ2h0PSI2NCIgd2lkdGg9IjY0IiB2aWV3Qm94PSIwIDAgMjQgMjQiIHhtbG5zPSJodHRwOi8vd3d3LnczLm9yZy8yMDAwL3N2ZyI+PHBhdGggZD0iTTkuMjA1IDguNjU4di0yLjI2YzAtLjE5LjA3Mi0uMzMzLjIzOC0uNDI4bDQuNTQzLTIuNjE2Yy42MTktLjM1NyAxLjM1Ni0uNTIzIDIuMTE3LS41MjMgMi44NTQgMCA0LjY2MiAyLjIxMiA0LjY2MiA0LjU2NiAwIC4xNjcgMCAuMzU3LS4wMjQuNTQ3bC00LjcxLTIuNzU5YS43OTcuNzk3IDAgMDAtLjg1NiAwbC01Ljk3IDMuNDczem0xMC42MDkgOC44VjEyLjA2YzAtLjMzMy0uMTQzLS41Ny0uNDI5LS43MzdsLTUuOTctMy40NzMgMS45NS0xLjExOGEuNDMzLjQzMyAwIDAxLjQ3NiAwbDQuNTQzIDIuNjE3YzEuMzA5Ljc2IDIuMTg5IDIuMzc4IDIuMTg5IDMuOTQ4IDAgMS44MDgtMS4wNyAzLjQ3My0yLjc2IDQuMTYzek03LjgwMiAxMi43MDNsLTEuOTUtMS4xNDJjLS4xNjctLjA5NS0uMjM5LS4yMzgtLjIzOS0uNDI4VjUuODk5YzAtMi41NDUgMS45NS00LjQ3MiA0LjU5MS00LjQ3MiAxIDAgMS45MjcuMzMzIDIuNzEyLjkyOEw4LjIzIDUuMDY3Yy0uMjg1LjE2Ni0uNDI4LjQwNC0uNDI4LjczN3Y2Ljg5OHpNMTIgMTUuMTI4bC0yLjc5NS0xLjU3di0zLjMzTDEyIDguNjU4bDIuNzk1IDEuNTd2My4zM0wxMiAxNS4xMjh6bTEuNzk2IDcuMjNjLTEgMC0xLjkyNy0uMzMyLTIuNzEyLS45MjdsNC42ODYtMi43MTJjLjI4NS0uMTY2LjQyOC0uNDA0LjQyOC0uNzM3di02Ljg5OGwxLjk3NCAxLjE0MmMuMTY3LjA5NS4yMzguMjM4LjIzOC40Mjh2NS4yMzNjMCAyLjU0NS0xLjk3NCA0LjQ3Mi00LjYxNCA0LjQ3MnptLTUuNjM3LTUuMzAzbC00LjU0NC0yLjYxN2MtMS4zMDgtLjc2MS0yLjE4OC0yLjM3OC0yLjE4OC0zLjk0OEE0LjQ4MiA0LjQ4MiAwIDAxNC4yMSA2LjMyN3Y1LjQyM2MwIC4zMzMuMTQzLjU3MS40MjguNzM4bDUuOTQ3IDMuNDQ5LTEuOTUgMS4xMThhLjQzMi40MzIgMCAwMS0uNDc2IDB6bS0uMjYyIDMuOWMtMi42ODggMC00LjY2Mi0yLjAyMS00LjY2Mi00LjUxOSAwLS4xOS4wMjQtLjM4LjA0Ny0uNTdsNC42ODYgMi43MWMuMjg2LjE2Ny41NzEuMTY3Ljg1NiAwbDUuOTctMy40NDh2Mi4yNmMwIC4xOS0uMDcuMzMzLS4yMzcuNDI4bC00LjU0MyAyLjYxNmMtLjYxOS4zNTctMS4zNTYuNTIzLTIuMTE3LjUyM3ptNS44OTkgMi44M2E1Ljk0NyA1Ljk0NyAwIDAwNS44MjctNC43NTZDMjIuMjg3IDE4LjMzOSAyNCAxNS44NCAyNCAxMy4yOTZjMC0xLjY2NS0uNzEzLTMuMjgyLTEuOTk4LTQuNDQ4LjExOS0uNS4xOS0uOTk5LjE5LTEuNDk4IDAtMy40MDEtMi43NTktNS45NDctNS45NDYtNS45NDctLjY0MiAwLTEuMjYuMDk1LTEuODguMzFBNS45NjIgNS45NjIgMCAwMDEwLjIwNSAwYTUuOTQ3IDUuOTQ3IDAgMDAtNS44MjcgNC43NTdDMS43MTMgNS40NDcgMCA3Ljk0NSAwIDEwLjQ5YzAgMS42NjYuNzEzIDMuMjgzIDEuOTk4IDQuNDQ4LS4xMTkuNS0uMTkgMS0uMTkgMS40OTkgMCAzLjQwMSAyLjc1OSA1Ljk0NiA1Ljk0NiA1Ljk0Ni42NDIgMCAxLjI2LS4wOTUgMS44OC0uMzA5YTUuOTYgNS45NiAwIDAwNC4xNjIgMS43MTN6Ii8+PC9zdmc+Cg==`,
	omp: `data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iNjQiIGhlaWdodD0iNjQiIHZpZXdCb3g9IjAgMCA2NCA2NCIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIiBhcmlhLWhpZGRlbj0idHJ1ZSI+PGRlZnM+PGxpbmVhckdyYWRpZW50IGlkPSJnaWQtb21wLWdyYWRpZW50IiB4MT0iMCIgeTE9IjAiIHgyPSIxIiB5Mj0iMSI+PHN0b3Agb2Zmc2V0PSIwIiBzdG9wLWNvbG9yPSJva2xjaCgwLjcgMC4yNCAzNDApIi8+PHN0b3Agb2Zmc2V0PSIuNSIgc3RvcC1jb2xvcj0ib2tsY2goMC42MiAwLjIxIDI5NSkiLz48c3RvcCBvZmZzZXQ9IjEiIHN0b3AtY29sb3I9Im9rbGNoKDAuODEgMC4xNCAyMDApIi8+PC9saW5lYXJHcmFkaWVudD48L2RlZnM+PHBhdGggZmlsbD0idXJsKCNnaWQtb21wLWdyYWRpZW50KSIgZD0iTTEwIDE0aDQ0djlINDN2MzNoLTlWMjNoLTl2MjJoLTlWMjNIMTB6Ii8+PC9zdmc+Cg==`,
	pi: `data:image/svg+xml;base64,PHN2ZyBoZWlnaHQ9IjY0IiB3aWR0aD0iNjQiIHZpZXdCb3g9IjAgMCA4MDAgODAwIiB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciPjxwYXRoIGZpbGw9IiNGRkZGRkYiIGZpbGwtcnVsZT0iZXZlbm9kZCIgZD0iTTE2NS4yOSAxNjUuMjkgSDUxNy4zNiBWNDAwIEg0MDAgVjUxNy4zNiBIMjgyLjY1IFY2MzQuNzIgSDE2NS4yOSBaIE0yODIuNjUgMjgyLjY1IFY0MDAgSDQwMCBWMjgyLjY1IFoiLz48cGF0aCBmaWxsPSIjRkZGRkZGIiBkPSJNNTE3LjM2IDQwMCBINjM0LjcyIFY2MzQuNzIgSDUxNy4zNiBaIi8+PC9zdmc+Cg==`,
	hermes: `data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAMAAACdt4HsAAAAPFBMVEVzc3Pn5+ccHBszMzMBAQH///8AAAAYGBgLCwscHBxLS0vGxsbX19dfX19+fn7z8/OgoKCysrKGhoaSkpIgp1CAAAAACnRSTlP9////ff//gICA//OAVQAABGdJREFUWIWll4uWnCAMQANUuiXh/f//2gRQAZ1te8rZs6MOXPNOBn7Af60f8Cse/7HUF/xUn76MmIJ3zodM/w6IRDml4uxYgO+CfgBQShnba1U6ESa9IV4BebxXB/lK+QuBfwXI2t6rypOy3n4PIGeX5eTbcN36PwGS3ZcWzS8tLHwLiP5xnDVnQtTnrU7fAJTZT2vtq5eX5v5Ae4v4EaBMe89N8c5mMaoccSKMNiGpED8BjNO6ndKDYUhsZsHwf7SWTVlEm/QBUCoTjE38KvBOGOnIKpJxSkKqpphTjCyQia8AQiJvTMrVGeRHThIgskLGuiL+0Zg0uMTo/ArI/KFqbW+jopTsihGaI8SVirXjS8cAH18AlChGRVB9CRokgkz1tQ5rdDNa/muGohcAeO0L6OGD0+1mXJRDEQe0k7BgQHkBaDf5z27xbD00J8hzPWJrA9Dlu+7AjaCT9m6A9VBpBdRL7H4grAC2CHuAwabvCw8AbAeSXm61JAmf1q4D3ANwZdE4CHUFdN3ZGONefQaMK1pFuFXpn/hZhVFHfbeCeRCGii9GPBd5KLaqI0EpIe+EISDsADo3tNJbsTifh7NXXYYO5hFIvlmqUE+U3EpRV3TIMOLktJHaAapJB1jbKRLRi4V4AQIi+UkH3AFcj0wSo41UKxyvQJMEdrjYd5XqA8AZn9Em0+I8YoYS6MUGLRjtHUprVVY2lO4gzmw1jLg7cujwCkBrpkztK34A0Bsg28f528GbI9MbILFt9hacd8AQwb8BqlUYt2Hi6qx6Beg3ANgY9xa+F6crHegF4Cwbf7Ph5sVWFScjrAAu+Rj6ZHLaYrehVIYugnsC+G2eG5yBSQ1c9Ze6IlkhUsQHgPPBqoQHTmr0PL8tKScF4Ec6LAARN6h1lmqVxuAsQasyeVTWBdC2TePG5YSibgmGQqh7TRiAPgS2+WadYboT6JpQWmltgNCN0AHU63yY/HsCesyco9M16VjM3QgdUHoKzO6Z7Gr9FUy3N5D1TQoHwIdrs+wnTuZcId9hkGEHEErL9QPgzGWCeeUB4CKVt/M2ZjFXyQ3A013oe/UauNRtQE+4kSrsj+SjABScRbfs25pnHW7P+eVChqOaLkEYhbOWtUlbsO8dzqIYJRyg1c9mg96Asmixpi88ClJbukV4OkyXgDVE5BxoVlgaPSxNbwK0/+wJPyLRW5e6q+rcDOvh1TuhUThw8gBcU/aUNrbyZJm5bOCjRfeV2JPxSibsfSvOJohovKYRDM61YdmFU0dNYoUpG8lRXGcldhN3Kw4iFwqbHZCUwlJ6j7TJSWWe09k6EGEnKyJVUSCTwrudkpFMlARxcQV09dMUNO5g/7KYMgVODVAn1038KGkVCh2zybR1dCiltJ2LteKR3obR1B+/2u5O5NhLKJ360GuRYLXc2QMfgLsPmNrV9px4e7cBNw0Y64/v4UbIPKy2ccenAx4tV10/hBnwBeFe47zj4V3rwg+8haJ92Fc5L+DrN9ijZSiX90rqAAAAAElFTkSuQmCC`,
	agy: `data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAMAAACdt4HsAAABYlBMVEVHcEw5iPw2i/IziPztaDo3ifeJwGA6iPhkhug3ifjtVEg6ivgujO00h/8wivRztHQ0iftrgdLrhy41ifA0iPs+mMJNrp7rWEgwifjgryrcVmJ4wXDiUlmPeMCGxWK3w0FhprPZVmJato0pktxVjflCqKqjbqeLxWKQeL/opSZBp6z1Uj3Xuy01ifwwiPg1h/87if8wh/wvivRCiv4vi+8zktxNjPsvjek1ltEwj+Q5nMTwV0BDpK9Rg+hZifJ5e8tMq6C7ZHk+h/k2h/nOW2lXsJBAn7mGdrx1vG9dgd1Jh/SebZ3lU07meDlitoKuZo1kfszdWlOgvlBWk69wgttBhe/Ia14/iOTaZ01Cj87gpSxzfbOHdqeVcaxMh9O7uz90loxwiKFah77GelWfrVdToKGSe4uud2+kcIXlky6Sm22+qENyp37Mh0iHq2pfpo6tmVeuh2LSszGJhonJlkKWi3VeO12PAAAALXRSTlMARBro/o/8f/1lxVMt8q79vAf6/cv6i23YVBo4QcePmg6TzuC5S3QaM6re4bufpM1dAAADxklEQVRYhZ2X+T9iURTAXz2VVIQYxowxY4wxM7wShWwVSrIvlchStopR+P/n3O0t3tqcH933/d5zzj339sFxBjE40dOz3dbxwegbI/z09AEE221tsf9STJyC4IEIYh2t83+aTVEAht+t8l+aRPC4TVJoNYfBi4tms3b6+voIhjw2fG1JcAFRq9WwoJxv2wdB7GMrBcgE5e18Pr8fy7ZSxPgBRKVSe35+fmyUy2VsiMU+WU8A85UKCBpIcAKCbDZrOYURkkDlqfpcbSDDyUl+HxmspjB84HQ6nyCq1epbo3F3d0INVlNwyniIO2RYW0OGbkv8kNOZTnd1ddXr9cvLt5e3WzDEicHanRjGfB3zl5cvL7e39/fxeBwMFmvA/E79LwQIrmSGtX0rwzSUTqd3dtYBv7k5PLyCOEOGXWywUEP3MObXAUcCMBSvzs62qMFKDV0if4ji+rpYLIJhaxcbzPlxzK+uLi5ubBz2AS8z7MbXzGepX+L7+gqFAjLsIcM5TsL8Un9T8oVSqbS3t7dSTFGDqYDxCwtzc8DnmCGVOscGs4MckvjC3OzsbC6XWyqVNsFAFLs/zFog7Y/w+RwyLG1Khs9mLZDx8/PRaDSHFZugoAZjvlvOR6Mzvb29x8fHS0s4CWRInf80FIwp+RlqOMaGoxWkMG5Cv5Kfnp5KJpMJ0QCKlHETfsl5wKeQIJkARYYYQGHEj0j8DOGxAAyZDBja25HAqAlj8v0RHgqFiAAZlrHhyGXUAjUPIYiG5XZQGDWhT1F/iPKCMCk3tOs/rXbF/qGQz+9wu12dvDAZDCbCCSRACpuuwE3nj/C8h/3dFhCCwWA4HIlEkMGhK+iU56/4zI0F4Qwx6AogAbw/4t3KJRsxkBzsOrxXxqvOSm5wa9EQDjpAwHeqV11YgAyR7zqCUfEAfFrLAZZCJKJ9kHapgZoHZReLiHi01jmX2AC/doYu0aBdwyi7QSG9LvvENmiterUnQB50GsLaNTjEG6A/6zwzaBXJTlA9AlLYBGYYUa15WAJJfZ7jBphBvcsAK0BvzHB4BWRACtUKK4A34jnOzwzv9/GzBPQvOw67QA3vNvIyPmDMw2ERQTCsPMkA8NPoDdObISl8NAdFCh46gkZHyMImCEQh/7aX8gPmPLxbzCBl20l+RKwUwIpACrFfbsZr31JVeAVqoJfGy34E9F/bd+GhBgEPg53xGs+YXriYAU0NT/PXeUW0w8EM3Zyr9f3lOTg4fqq1+lm4icDHEd7kBmiFF58mz9n40IDL2r8yqiQCvN/+D+aPcPZ+RgT3AAAAAElFTkSuQmCC`
};
/**
* The DSH fish silhouette (FishLogo geometry, tight 23.16:17.04 viewBox) at
* the official site's brand blue.
*
* @param props - `size`: width in pixels (height keeps the native ratio).
* @returns the blue fish mark.
*/
function DshFish({ size }) {
	return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("svg", {
		width: size,
		height: size * 17.04 / 23.16,
		viewBox: "0 0 23.16 17.04",
		fill: "none",
		xmlns: "http://www.w3.org/2000/svg",
		"aria-hidden": "true",
		style: {
			display: "block",
			flex: "none"
		},
		children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", {
			fill: "#4D6BFE",
			d: "M22.9168 1.43018C22.6713 1.31018 22.5658 1.53918 22.4223 1.65519C22.3733 1.69269 22.3318 1.74169 22.2903 1.78669C21.9317 2.1697 21.5127 2.42121 20.9657 2.39121C20.1657 2.34621 19.4827 2.59771 18.8787 3.20973C18.7502 2.45521 18.3236 2.0047 17.6746 1.71569C17.3351 1.56568 16.9916 1.41518 16.7536 1.08867C16.5876 0.856163 16.5421 0.597155 16.4591 0.341647C16.4061 0.187643 16.3536 0.0301382 16.1761 0.00363739C15.9836 -0.0263635 15.9081 0.135141 15.8326 0.270145C15.5306 0.822162 15.4136 1.43018 15.4251 2.0462C15.4516 3.43174 16.0366 4.53527 17.1991 5.3203C17.3311 5.4103 17.3651 5.5003 17.3236 5.63181C17.2441 5.90231 17.1501 6.16482 17.0671 6.43533C17.0141 6.60784 16.9351 6.64584 16.7501 6.57033C16.1121 6.30383 15.5611 5.90931 15.074 5.4328C14.2475 4.63328 13.5 3.75075 12.568 3.05973C12.349 2.89822 12.13 2.74822 11.9034 2.60522C10.9524 1.68169 12.028 0.923165 12.277 0.833162C12.5375 0.739159 12.3675 0.41615 11.5259 0.42015C10.6844 0.42365 9.91439 0.705658 8.93286 1.08117C8.78935 1.13767 8.63835 1.17867 8.48384 1.21267C7.59332 1.04367 6.66829 1.00617 5.70226 1.11517C3.88321 1.31768 2.43016 2.1777 1.36213 3.64575C0.0790928 5.4103 -0.222916 7.41536 0.146595 9.50642C0.535106 11.7105 1.66014 13.535 3.38869 14.9616C5.18125 16.4406 7.24581 17.1657 9.60138 17.0266C11.0319 16.9441 12.6245 16.7526 14.421 15.2321C14.874 15.4576 15.3496 15.5476 16.1381 15.6151C16.7456 15.6716 17.3306 15.5851 17.7836 15.4911C18.4931 15.3411 18.4441 14.6841 18.1876 14.5636C16.1081 13.595 16.5646 13.9891 16.1496 13.67C17.2061 12.42 18.8202 10.1979 19.3182 7.17235C19.3672 6.83834 19.4297 6.36783 19.4222 6.09732C19.4182 5.93231 19.4562 5.86831 19.6447 5.84931C20.1657 5.78931 20.6712 5.64681 21.1357 5.3913C22.4833 4.65528 23.0268 3.44624 23.1548 1.9972C23.1738 1.77569 23.1508 1.54668 22.9168 1.43018ZM11.1749 14.4736C9.15936 12.889 8.18184 12.3675 7.77832 12.39C7.40081 12.4125 7.46881 12.8445 7.55182 13.126C7.63882 13.404 7.75182 13.5955 7.91033 13.8396C8.01983 14.0011 8.09533 14.2411 7.80083 14.4216C7.15181 14.8231 6.02327 14.2866 5.97027 14.2601C4.65673 13.4865 3.5587 12.4655 2.78467 11.069C2.03715 9.72493 1.60314 8.28289 1.53164 6.74384C1.51264 6.37233 1.62214 6.24082 1.99215 6.17332C2.47916 6.08332 2.98118 6.06432 3.46769 6.13582C5.52476 6.43633 7.27581 7.35586 8.74385 8.8129C9.58188 9.64243 10.2159 10.634 10.8689 11.6025C11.5634 12.631 12.3105 13.611 13.262 14.4146C13.598 14.6961 13.866 14.9101 14.1225 15.0681C13.349 15.1546 12.058 15.1731 11.1749 14.4746L11.1749 14.4736ZM12.141 8.25988C12.141 8.09488 12.273 7.96338 12.439 7.96338C12.4765 7.96338 12.5105 7.97088 12.541 7.98188C12.5825 7.99688 12.6205 8.01938 12.6505 8.05338C12.7035 8.10588 12.7335 8.18088 12.7335 8.25988C12.7335 8.42489 12.6015 8.55639 12.4355 8.55639C12.2695 8.55639 12.141 8.42489 12.141 8.25988ZM15.1415 9.79893C14.949 9.87793 14.7565 9.94544 14.5715 9.95294C14.2845 9.96794 13.9715 9.85143 13.8015 9.70893C13.5375 9.48742 13.3485 9.36342 13.2695 8.97691C13.2355 8.8119 13.2545 8.55639 13.2845 8.40989C13.3525 8.09438 13.277 7.89187 13.0545 7.70787C12.8735 7.55786 12.6435 7.51636 12.39 7.51636C12.2955 7.51636 12.2095 7.47486 12.1445 7.44136C12.0395 7.38886 11.9519 7.25735 12.035 7.09585C12.0615 7.04335 12.19 6.91584 12.22 6.89334C12.5635 6.69784 12.9595 6.76184 13.326 6.90834C13.6655 7.04735 13.9225 7.30236 14.292 7.66287C14.6695 8.09838 14.7375 8.21838 14.9525 8.54539C15.1225 8.8009 15.2775 9.06341 15.3831 9.36392C15.4471 9.55142 15.3641 9.70493 15.1415 9.79893Z"
		})
	});
}
/** Opaque tile backgrounds for marks that would vanish on a dark frame. */
const RUNTIME_TILE_BG = {
	codex: "#FFFFFF",
	pi: "#000000"
};
/** Sanitized useId: raw React ids contain colons, kept out of url(#…) refs. */
function useGlyphId() {
	return `superd_subagent_${react.useId().replaceAll(":", "")}`;
}
/**
* The subagent mark: two stacked rounded squares (the Plugins page's
* subagent artwork, redrawn in-bundle) — the default foreign-agent icon.
*
* @param props - `size`: square edge in pixels.
* @returns the subagent mark.
*/
function SubagentGlyph({ size }) {
	const uid = useGlyphId();
	return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("svg", {
		width: size,
		height: size,
		viewBox: "8.47 8.67 19.16 19.16",
		fill: "none",
		xmlns: "http://www.w3.org/2000/svg",
		"aria-hidden": "true",
		style: {
			display: "block",
			flex: "none"
		},
		children: [
			/* @__PURE__ */ (0, react_jsx_runtime.jsx)("rect", {
				x: "14.99",
				y: "15.19",
				width: "12.24",
				height: "12.24",
				rx: "2.4",
				fill: `url(#${uid}a)`,
				fillOpacity: "0.85"
			}),
			/* @__PURE__ */ (0, react_jsx_runtime.jsx)("rect", {
				x: "8.87",
				y: "9.07",
				width: "12.24",
				height: "12.24",
				rx: "2.4",
				fill: `url(#${uid}b)`,
				fillOpacity: "0.85"
			}),
			/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("defs", { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("linearGradient", {
				id: `${uid}a`,
				x1: "21.11",
				y1: "15.19",
				x2: "21.11",
				y2: "27.42",
				gradientUnits: "userSpaceOnUse",
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("stop", { stopColor: "#45E7A4" }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("stop", {
					offset: "1",
					stopColor: "#05909D"
				})]
			}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("linearGradient", {
				id: `${uid}b`,
				x1: "14.99",
				y1: "9.07",
				x2: "14.99",
				y2: "21.31",
				gradientUnits: "userSpaceOnUse",
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("stop", { stopColor: "#69B9FF" }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("stop", {
					offset: "1",
					stopColor: "#324DE2"
				})]
			})] })
		]
	});
}
/** One embedded square image mark at the requested edge. */
function imgMark(uri, size) {
	return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("img", {
		src: uri,
		alt: "",
		width: size,
		height: size,
		style: {
			display: "block",
			flex: "none",
			objectFit: "contain"
		}
	});
}
/**
* Render one runtime's mark: the DSH app icon for native (scheme-aware), the
* curated asset for a matching roster key, the subagent mark otherwise.
*
* @param props - `agentKey`: the roster key; `size`: square edge in pixels.
* @returns the runtime mark.
*/
function RuntimeMark({ agentKey, size }) {
	if (agentKey === "native") return /* @__PURE__ */ (0, react_jsx_runtime.jsx)(DshFish, { size });
	const uri = RUNTIME_ICON_URIS[agentKey];
	if (uri === void 0) return /* @__PURE__ */ (0, react_jsx_runtime.jsx)(SubagentGlyph, { size });
	const tile = RUNTIME_TILE_BG[agentKey];
	if (tile === void 0) return imgMark(uri, size);
	return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
		"aria-hidden": "true",
		style: {
			width: size,
			height: size,
			flex: "none",
			borderRadius: Math.max(3, Math.round(size * .2)),
			background: tile,
			display: "inline-flex",
			alignItems: "center",
			justifyContent: "center"
		},
		children: imgMark(uri, Math.round(size * .74))
	});
}

//#endregion
//#region src/client/roster.ts
/** The native runtime every composition can fall back to. */
const NATIVE_LINK = {
	key: "native",
	label: "DSH",
	path: "/"
};
/** Labels for the read-only face's bare keys (it reports keys, not labels). */
const FALLBACK_LABELS = {
	native: "DSH",
	omp: "OMP",
	codex: "Codex",
	claude: "Claude",
	pi: "Pi",
	hermes: "Hermes",
	agy: "Antigravity"
};
/** Coerce a wire `agents` array into links; undefined when unusable/empty. */
function coerceAgents(raw) {
	if (!Array.isArray(raw)) return void 0;
	const links = [];
	for (const entry of raw) {
		if (typeof entry !== "object" || entry === null) continue;
		const { key, label, path, machine } = entry;
		if (typeof key !== "string" || typeof path !== "string") continue;
		links.push({
			key,
			label: typeof label === "string" ? label : FALLBACK_LABELS[key] ?? key,
			path,
			...typeof machine === "string" ? { machine } : {}
		});
	}
	return links.length > 0 ? links : void 0;
}
/** Seed from the index-baked roster global, when the page carries one. */
function rosterFromGlobal() {
	const raw = globalThis.__DSH_AGENT_ROSTER__;
	return coerceAgents(raw?.agents);
}
/** Normalize the current mount root: `/omp` and `/omp/` are the same page. */
function currentMountPath() {
	const pathname = typeof location === "undefined" ? "/" : location.pathname;
	if (pathname === "" || pathname === "/") return "/";
	return pathname.endsWith("/") ? pathname : `${pathname}/`;
}
/**
* Ask the hub for the live roster (preferred `agents` shape with paths; the
* bare `available` key list falls back to `/<key>/` paths).
*
* @returns the runtime links, keyed by runtime.
* @throws when the face is unreachable or returns no usable roster.
*/
async function fetchRoster() {
	const response = await fetch("/api/agent-runtime", { credentials: "same-origin" });
	if (!response.ok) throw new Error(`HTTP ${response.status}`);
	const json = await response.json();
	const agents = coerceAgents(json.agents);
	if (agents !== void 0) return agents;
	if (Array.isArray(json.available)) {
		const links = [];
		for (const key of json.available) {
			if (typeof key !== "string") continue;
			links.push(key === "native" ? NATIVE_LINK : {
				key,
				label: FALLBACK_LABELS[key] ?? key,
				path: `/${key}/`
			});
		}
		if (links.length > 0) return links;
	}
	throw new Error("agent-runtime face returned no roster");
}

//#endregion
//#region src/client/machines-store.ts
/** Storage slot for the ledger (v1 shape; bump the suffix on breaking edits). */
const STORAGE_KEY = "superd-hub.machines.v1";
/**
* The self row is DERIVED, never stored: this machine's label tracks the
* product copy and its URL tracks the serving origin on every load. Only
* remote machines persist.
*/
function selfMachine() {
	return {
		id: "self",
		name: "local",
		label: "This machine",
		url: typeof location === "undefined" ? "" : location.origin,
		self: true,
		addedAt: 0
	};
}
/**
* Read the ledger; a missing or unreadable store resets to the self row.
*
* @returns the machines: the derived self row first, then the stored remotes.
*/
function loadMachines() {
	const remotes = readStoredRemotes();
	return [selfMachine(), ...remotes];
}
/** Parse the stored remote machines; storage failures degrade to none. */
function readStoredRemotes() {
	if (typeof localStorage === "undefined") return [];
	let parsed;
	try {
		const raw = localStorage.getItem(STORAGE_KEY);
		if (raw === null) return [];
		parsed = JSON.parse(raw);
	} catch {
		return [];
	}
	if (!Array.isArray(parsed)) return [];
	const list = [];
	for (const entry of parsed) {
		if (typeof entry !== "object" || entry === null) continue;
		const { id, name, label, url, self, addedAt } = entry;
		if (self === true) continue;
		if (typeof id !== "string" || typeof name !== "string" || typeof url !== "string") continue;
		list.push({
			id,
			name,
			label: typeof label === "string" ? label : name,
			url,
			self: false,
			addedAt: typeof addedAt === "number" ? addedAt : 0
		});
	}
	return list;
}
/**
* Persist the ledger; storage failures degrade silently to in-memory state.
*
* @param list - the machines to store (self row included).
*/
function saveMachines(list) {
	if (typeof localStorage === "undefined") return;
	try {
		localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
	} catch {}
}
/** A fresh row id (UUID when available, time+random otherwise). */
function freshMachineId() {
	const cryptoRef = globalThis.crypto;
	if (typeof cryptoRef?.randomUUID === "function") return cryptoRef.randomUUID();
	return `m-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

//#endregion
//#region src/switch-core.ts
/**
* Switch orchestration core (native UI fusion, plan Task 4) — the pure logic
* behind the in-page agent switch: storage-namespace key computation, the
* session landing decision over the persisted `dsh.sessions.current`
* selection, the agent-selector click-interception decision (a fusion page
* never navigates on a left click — spec: 融合页 = state 切换，拦截 click，无导航;
* T-B: consumed by the Hub UI surfaces, the sole switch surface since the
* RuntimeSeat retirement), and the fallback state machine (timeout or
* roster-probe failure → revert to native + a visible toast, never a page
* lock).
*
* Host-half on purpose: plain TS with every effect injected through
* {@link SwitchHost} — no DOM, no client imports — so `test/client-switch.test.mjs`
* imports it from `dist/` like every other host module. The client half
* (`src/client/switch.ts`) builds the real host face from the client context:
* the `__SUPERD_UI_STATE__` atom (Task 3), `ctx.connection`,
* `ctx.uiWorkspace`, the Task-3 namespaced `Storage`, the control-plane
* roster fetch, and a minimal self-owned toast overlay.
*
* Orchestration sequence (spec §3.5 as amended 2026-09-26, T-A erratum;
* user rulings 7/8):
*   1. `setAgent(label)` — state + NS swap immediately; subsequent requests
*      demux to the target world (Task 3's call-time patches read the atom).
*   2. Session landing, split by the target NS's `dsh.sessions.current`:
*      a navigable value is opened through the uiWorkspace face right away —
*      session-targeted navigation resolves no workspace id, so it is
*      correct against the retargeted plane before reconnect (the clean
*      round-4 acceptance behavior). Anything else lands on new chat, but
*      only once the target plane's wire-derived caches are fresh (see 3):
*      upstream `startSession()` resolves `currentWorkspaceId ?? recent`
*      from those caches (navigation.ts:223-238), and a pre-reconnect
*      resolution reads the PREVIOUS plane's data → `workspace/not-found`
*      toast + the view pinned to the dead previous session id (the
*      2026-09-26 live-acceptance defect). The chat area is never cleared
*      and no loading skeleton is inserted: old content stays in place
*      awaiting the landing.
*   3. `reconnect()` — the generation re-opens against the retargeted data
*      plane; the gateway emits `connection/reset` on establishment, the
*      designed "wire-derived caches must repull" signal, so sessions /
*      config / theme re-derive on their own. Upstream's one-shot boot
*      restore (`watchNavigation`'s `initial` flag) does not re-run after a
*      reset, so this landing is the switch's only navigation authority.
*      The deferred new-chat landing fires when the repull has LANDED — the
*      first post-establishment baseline replacement in the workspace store
*      ({@link observeCachesRefreshed}) — at which point `startSession()`
*      resolves the target agent's own workspace exactly like the native
*      new-chat button would on that plane.
*   4. Fallback: no generation within {@link SWITCH_FALLBACK_MS}, or a failed
*      roster probe → `setAgent('native')` + `reconnect()` back to the native
*      plane + toast. A revert also cancels a pending new-chat landing — a
*      reverted switch never lands.
*
* Upstream anchors (dsh-v0.1.7-rc.1):
*   - `ctx.connection.reconnect()` — `packages/client/connection/src/client/index.ts`
*     `ConnectionHandle.reconnect` (declared :148, wired :264-266); the
*     controller resets retry progression and replaces the current attempt
*     immediately (`connection.ts:113-121`).
*   - `connection/reset` — emitted by the gateway client on every generation
*     establishment (`packages/api/gateway/src/client/index.ts:169`),
*     declared as the repull signal
*     (`packages/client/connection/src/client/index.ts:9-17`).
*   - `uiWorkspace.openSession(target)` / `startSession()` — the navigation
*     face (`packages/client/ui-workspace/src/client/navigation.ts:34-92`);
*     `SessionTarget = SessionId | SubagentAddress`
*     (`packages/api/session-controller/src/client/contract/sessions.ts:22`).
*   - `startSession()`'s workspace resolution — `workspaceId ??
*     currentWorkspaceId ?? recent` over the wire-derived `workspaces.list`
*     / `sessions.list` snapshots (`navigation.ts:223-238`); the workspace
*     store installs fresh data only through its follow-stream baseline
*     (`packages/api/workspace-controller/src/client/model.ts`
*     `replaceBaseline` → `installViews`, a new items array every install).
*   - `dsh.sessions.current` — the per-tab last-selection store
*     (`navigation.ts:130-131`); its restore reads `subagentAddress` first,
*     then `sessionId` (`navigation.ts:319-330`) — {@link parseLandingTarget}
*     keeps that precedence. The store hydrates once at page boot and
*     persists on write (`packages/client/store/src/index.ts:155-174`), so
*     the post-switch read must go through the namespaced `Storage` (Task 3
*     patch 5), which prefixes `'<label>:'` at call time.
*
* @module @pgmi-builds/superd-hub/switch-core
*/
/** The active-agent label meaning the native (ctx0) data plane. */
const NATIVE_AGENT = "native";
/** The persisted last-selection key ui-workspace owns (survey §2.6). */
const SESSIONS_CURRENT_KEY = "dsh.sessions.current";
/**
* The fallback window: how long a switch may wait for the target world's
* generation (mux re-open + repull) before reverting to native. A
* human-scale constant; Task 5's config face may expose it later.
*/
const SWITCH_FALLBACK_MS = 1e4;
/**
* The landing decision over one raw persisted-selection read.
*
* A value is navigable when it parses to a ui-workspace `MainSelection`
* carrying a usable `SessionTarget`: a non-null `subagentAddress` object
* wins (upstream restore order), else a non-empty string `sessionId`.
* Everything else — no value, a read failure (surfaced here as `null`), a
* parse failure, an unusable shape — lands on new chat.
*
* @returns the exact `uiWorkspace.openSession` argument, or `null` for the
*   new-chat (blank session) landing.
*/
function parseLandingTarget(raw) {
	if (typeof raw !== "string" || raw === "") return null;
	let parsed;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return null;
	}
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
	const selection = parsed;
	if (selection.subagentAddress !== void 0 && selection.subagentAddress !== null && typeof selection.subagentAddress === "object") return selection.subagentAddress;
	if (typeof selection.sessionId === "string" && selection.sessionId !== "") return selection.sessionId;
	return null;
}
/**
* The caches-fresh gate behind the deferred new-chat landing: fires
* `listener` exactly once, when the navigation caches demonstrably hold the
* TARGET plane's data.
*
* The freshness token is the snapshot's `items` ARRAY IDENTITY: upstream's
* workspace model mints a new array on every baseline install
* (`installViews` → `[...installed.values()]`, model.ts:398) while carrier
* churn (`handleCarrierFailure`) keeps the reference. The gate arms at the
* first generation establishment OBSERVED BY ITS OWN subscription — the
* anchor is retaken there, and nothing before that point can pass, so the
* dying old plane's last increments racing the reconnect are absorbed; the
* first replacement after establishment is the target plane's baseline. The
* `phase === 'ready'` check rides along as a guard against a page whose
* first baseline never arrived.
*
* Establishment strictly precedes any target-plane baseline (the follow
* streams re-open on top of the established generation), so this single
* edge implies both "generation established" and "repull landed" — the two
* preconditions of a correct `startSession()` resolution.
*
* Host-half pure logic: the client binding composes it with the real
* `ctx.workspaces.list` store and the connection generation observable; the
* machine consumes it through {@link SwitchHost.onCachesRefreshed}.
*
* @returns the disposer stopping both subscriptions.
*/
function observeCachesRefreshed(list, generation, listener) {
	let anchor = list.getSnapshot().items;
	let established = false;
	const disposeGeneration = generation.subscribe(() => {
		if (generation.getSnapshot() === void 0) return;
		established = true;
		anchor = list.getSnapshot().items;
	});
	const disposeList = list.subscribe(() => {
		if (!established) return;
		const snapshot = list.getSnapshot();
		if (snapshot.phase === "ready" && snapshot.items !== anchor) listener();
	});
	return () => {
		disposeList();
		disposeGeneration();
	};
}
/**
* The agent-selector click-interception contract as a pure table (native UI
* fusion; originally landed for the sidebar-bottom RuntimeSeat, which T-B
* retired — the Hub UI surfaces (HubPage rows + the HubPanelIcon chevron
* menu) are now the sole switch surface and consume this SAME table, so the
* contract below is inherited verbatim).
*
*   - World page (`fusion: false`): no interception, no orchestration — the
*     real hyperlink navigates (spec §5 双半边).
*   - Fusion page, active entry: intercepted, no attempt — switching to the
*     active agent is a no-op, and the click must never fall through to the
*     anchor (an `href="/"` reload would discard the in-page switch state; a
*     foreign `href` would abandon the fused page entirely).
*   - Fusion page, inactive entry: intercepted and the attempt runs. The
*     attempt's `false` (orchestration unbound) still keeps the page: a
*     swallowed click beats silent navigation away from the fusion surface.
*
* Host-half pure logic so `test/client-switch.test.mjs` pins the table from
* `dist/`; the Hub surfaces map `preventDefault` onto the DOM event.
*/
function seatClickDecision(input) {
	if (!input.fusion) return {
		preventDefault: false,
		attempted: false
	};
	if (input.active) return {
		preventDefault: true,
		attempted: false
	};
	return {
		preventDefault: true,
		attempted: input.attempt() === true
	};
}
/**
* Which Hub UI roster row shows as the active agent (T-B: the Hub surfaces —
* HubPage rows and the HubPanelIcon chevron menu — are the sole switch
* surface after the RuntimeSeat retirement).
*
*   - Fusion page: the page atom's `activeAgent` — the switch state — decides
*     by roster key; the URL is irrelevant on a fused page. The `native`
*     entry participates like any other key.
*   - World page (interim until T-C deletes the arm): the mount path is the
*     selection — the entry whose path equals the page's normalized mount.
*
* Host-half pure logic so `test/client-switch.test.mjs` pins it from `dist/`.
*/
function hubRowActive(input) {
	if (input.fusion) return input.agentKey === input.activeAgent;
	return input.agentPath === input.mountPath;
}
/**
* Build the switch machine over an injected {@link SwitchHost}.
*
* Only one attempt is ever armed at a time: starting a new switch finishes
* the previous one silently (timer cleared, subscription released, promise
* resolved) and cancels its pending landing, so a stale attempt can never
* revert or land over a newer switch.
*/
function createSwitchController(host, options = {}) {
	const fallbackMs = options.fallbackMs ?? SWITCH_FALLBACK_MS;
	let current;
	return { run(label) {
		const prior = current;
		return new Promise((resolve) => {
			let timer;
			let disposer = () => {};
			let disposeLanding = () => {};
			const attempt = {
				finished: false,
				dead: false,
				cancelLanding() {
					attempt.dead = true;
					disposeLanding();
					disposeLanding = () => {};
				},
				finish() {
					if (attempt.finished) return;
					attempt.finished = true;
					host.clearTimeout(timer);
					disposer();
					if (current === attempt) current = void 0;
					resolve();
				}
			};
			if (prior !== void 0) {
				prior.cancelLanding();
				if (!prior.finished) prior.finish();
			}
			current = attempt;
			const revert = (reason) => {
				if (attempt.finished || current !== attempt) return;
				attempt.cancelLanding();
				try {
					host.setAgent(NATIVE_AGENT);
				} catch {}
				try {
					host.reconnect();
				} catch {}
				try {
					host.toast(`Super D: switch to ${label} failed (${reason === "timeout" ? "no response" : "target not reachable"}) — back to native.`);
				} catch {}
				attempt.finish();
			};
			try {
				host.setAgent(label);
			} catch {}
			let raw = null;
			try {
				raw = host.readPersistedSelection();
			} catch {
				raw = null;
			}
			const target = parseLandingTarget(raw);
			let deferNewChat = true;
			if (target !== null) try {
				host.openSession(target);
				deferNewChat = false;
			} catch {
				deferNewChat = true;
			}
			try {
				host.reconnect();
			} catch {}
			timer = host.setTimeout(() => {
				revert("timeout");
			}, fallbackMs);
			disposer = host.onGenerationEstablished(() => {
				if (attempt.finished || current !== attempt) return;
				attempt.finish();
			});
			if (deferNewChat) disposeLanding = host.onCachesRefreshed(() => {
				if (attempt.dead) return;
				disposeLanding();
				disposeLanding = () => {};
				try {
					host.openNewChat();
				} catch {}
			});
			host.probeTarget(label).then((alive) => {
				if (alive !== true) revert("probe");
			}, () => {
				revert("probe");
			});
		});
	} };
}

//#endregion
//#region src/client/switch.ts
/** Whether this page is a fusion page: the baked flag global is present. */
function fusionPage() {
	return globalThis.__SUPERD_UI_FUSION__ === true;
}
/** The page atom, when the page carries one (it always does on a fusion page). */
function uiState() {
	const state = globalThis.__SUPERD_UI_STATE__;
	if (state === void 0) return void 0;
	if (typeof state.setAgent !== "function") return void 0;
	if (typeof state.subscribe !== "function" || typeof state.activeAgent !== "string") return void 0;
	return state;
}
/** How long one revert toast stays on screen. */
const TOAST_HOLD_MS = 6e3;
/**
* One transient message, fixed above the sidebar footer. Self-owned
* presentation only — no read from any foreign DOM, nothing is a state input.
*/
function showToast(message) {
	try {
		const doc = globalThis.document;
		if (doc === void 0 || doc.body === null) return;
		const el = doc.createElement("div");
		el.textContent = message;
		el.setAttribute("style", [
			"position:fixed",
			"left:50%",
			"bottom:64px",
			"transform:translateX(-50%)",
			"z-index:9999",
			"max-width:80vw",
			"padding:10px 14px",
			"border-radius:8px",
			"background:rgba(24,24,28,.94)",
			"color:#ececf0",
			"font:13px/1.4 system-ui,sans-serif",
			"box-shadow:0 8px 24px rgba(0,0,0,.35)"
		].join(";"));
		doc.body.appendChild(el);
		globalThis.setTimeout(() => {
			try {
				el.remove();
			} catch {}
		}, TOAST_HOLD_MS);
	} catch {}
}
/** The bound `switchAgent`, or `undefined` until the entry binds it. */
let bound;
/**
* Bind the page's switch agent from the client services. Idempotent; a no-op
* without the page atom (a non-fusion page never has one).
* @param deps - the `connection`, `uiWorkspace` and `workspaces` services
*   (structural).
*/
function bindSwitchAgent(deps) {
	if (bound !== void 0) return;
	const state = uiState();
	if (state === void 0) return;
	const controller = createSwitchController({
		setAgent(label) {
			state.setAgent(label);
		},
		readPersistedSelection() {
			const storage = globalThis.localStorage;
			return storage === void 0 ? null : storage.getItem(SESSIONS_CURRENT_KEY);
		},
		openSession(target) {
			deps.uiWorkspace.openSession(target);
		},
		openNewChat() {
			deps.uiWorkspace.startSession();
		},
		onCachesRefreshed(listener) {
			return observeCachesRefreshed(deps.workspaces.list, deps.connection.generation, listener);
		},
		reconnect() {
			deps.connection.reconnect();
		},
		onGenerationEstablished(listener) {
			const generation = deps.connection.generation;
			return generation.subscribe(() => {
				if (generation.getSnapshot() !== void 0) listener();
			});
		},
		async probeTarget(label) {
			try {
				return (await fetchRoster()).some((agent) => agent.key === label);
			} catch {
				return false;
			}
		},
		toast: showToast,
		setTimeout(fn, ms) {
			return globalThis.setTimeout(fn, ms);
		},
		clearTimeout(handle) {
			globalThis.clearTimeout(handle);
		}
	});
	bound = (label) => controller.run(label);
}
/**
* The Hub switch surfaces' entry point. Attempts the in-page switch for
* `label`.
* @returns `true` when the fusion switch took the click over; `false` when
*   this page is not a fusion page or the orchestration is unbound.
*   Informational only — the interception contract (`seatClickDecision`)
*   prevents navigation on every fusion-page left click regardless: a
*   `false` means the click is swallowed, never that the anchor navigates
*   the fused page away (review round 1).
*/
function attemptSwitch(label) {
	const run = bound;
	if (run === void 0 || !fusionPage()) return false;
	run(label).catch(() => {});
	return true;
}

//#endregion
//#region src/client/HubPage.tsx
const EMPTY_DRAFT = {
	name: "",
	url: ""
};
/** Chip text: drop the trailing slash for concision ('/claude/' → '/claude'). */
function displayPath(path) {
	return path.length > 1 && path.endsWith("/") ? path.slice(0, -1) : path;
}
/** Shared chip look (status pills, path tags). */
const chip = {
	fontSize: 10,
	lineHeight: 1.4,
	padding: "2px 7px",
	borderRadius: 999,
	whiteSpace: "nowrap",
	background: "color-mix(in srgb, currentColor 10%, transparent)"
};
const chipSelf = {
	...chip,
	background: "color-mix(in srgb, var(--dsw-alias-state-success-primary) 14%, transparent)",
	color: "var(--dsw-alias-state-success-primary)"
};
const chipPending = {
	...chip,
	color: "var(--dsw-alias-label-caption)"
};
const inputStyle = {
	boxSizing: "border-box",
	width: "100%",
	minWidth: 0,
	padding: "7px 10px",
	borderRadius: 8,
	border: "1px solid var(--dsw-alias-border-l3)",
	background: "transparent",
	color: "inherit",
	font: "inherit",
	fontSize: 13
};
const fieldLabel = {
	display: "block",
	marginBottom: 4,
	fontSize: 11,
	color: "var(--dsw-alias-label-caption)"
};
const listStyle = {
	margin: 0,
	padding: 0,
	listStyle: "none",
	display: "flex",
	flexDirection: "column",
	gap: 2
};
/** A row that lights its surface on hover (inline styles have no :hover). */
function HoverRow({ children, onClick, clickable }) {
	const [hover, setHover] = react.useState(false);
	return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("li", {
		onClick,
		onMouseEnter: () => {
			setHover(true);
		},
		onMouseLeave: () => {
			setHover(false);
		},
		style: {
			display: "flex",
			alignItems: "center",
			gap: 12,
			margin: "0 -8px",
			padding: "9px 8px",
			borderRadius: 12,
			listStyle: "none",
			background: hover ? "var(--dsw-alias-interactive-bg-hover)" : "transparent",
			cursor: clickable ? "pointer" : void 0
		},
		children
	});
}
/** Section head: title, count, and a trailing action slot. */
function GroupHead({ title, count, action }) {
	return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
		style: {
			display: "flex",
			alignItems: "baseline",
			gap: 8
		},
		children: [
			/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h2", {
				style: {
					margin: 0,
					fontSize: 14,
					lineHeight: "22px",
					fontWeight: 500
				},
				children: title
			}),
			/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
				style: {
					fontSize: 13,
					color: "var(--dsw-alias-label-caption)",
					fontVariantNumeric: "tabular-nums"
				},
				children: count
			}),
			/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { style: { flex: 1 } }),
			action
		]
	});
}
function HubPage() {
	const [machines, setMachines] = react.useState(() => loadMachines());
	const [showAdd, setShowAdd] = react.useState(false);
	const [draft, setDraft] = react.useState(EMPTY_DRAFT);
	const [agents, setAgents] = react.useState(() => rosterFromGlobal() ?? null);
	const [rosterFailed, setRosterFailed] = react.useState(false);
	const [tab, setTab] = react.useState("home");
	const fusion = fusionPage();
	const [activeKey, setActiveKey] = react.useState(() => fusion ? uiState()?.activeAgent : void 0);
	react.useEffect(() => {
		let cancelled = false;
		fetchRoster().then((list) => {
			if (!cancelled) {
				setAgents(list);
				setRosterFailed(false);
			}
		}).catch(() => {
			if (!cancelled) {
				setAgents((prev) => prev ?? [NATIVE_LINK]);
				setRosterFailed(true);
			}
		});
		return () => {
			cancelled = true;
		};
	}, []);
	react.useEffect(() => {
		if (!fusion) return;
		const state = uiState();
		if (state === void 0) return;
		return state.subscribe((label) => {
			setActiveKey(label);
		});
	}, [fusion]);
	const here = currentMountPath();
	const isActive = (agent) => hubRowActive({
		fusion,
		agentKey: agent.key,
		agentPath: agent.path,
		activeAgent: activeKey,
		mountPath: here
	});
	/**
	* The row's click decision — the SAME table the retired sidebar seat ran:
	* on a fusion page EVERY left click is intercepted (active entry included),
	* the attempt runs for non-active entries only, and `preventDefault` keeps
	* the anchor from navigating the fused page away; on a world page the real
	* hyperlink stays in charge (interim arm, T-C deletes it).
	*/
	const rowDecision = (agent, event) => {
		if (seatClickDecision({
			fusion,
			active: isActive(agent),
			attempt: () => attemptSwitch(agent.key)
		}).preventDefault) event.preventDefault();
	};
	const persist = (next) => {
		const list = [...next];
		setMachines(list);
		saveMachines(list);
	};
	const addMachine = () => {
		const name = draft.name.trim();
		const url = draft.url.trim();
		if (name === "" || url === "") return;
		persist([...machines, {
			id: freshMachineId(),
			name,
			label: name,
			url,
			self: false,
			addedAt: Date.now()
		}]);
		setDraft(EMPTY_DRAFT);
		setShowAdd(false);
	};
	const removeMachine = (id) => {
		persist(machines.filter((machine) => machine.id !== id));
	};
	const draftValid = draft.name.trim() !== "" && draft.url.trim() !== "";
	return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
		style: {
			display: "flex",
			flexDirection: "column",
			alignItems: "center",
			height: "100%",
			overflowY: "auto",
			boxSizing: "border-box",
			padding: "28px clamp(24px, 4vw, 48px) 48px",
			color: "var(--dsw-alias-label-primary)"
		},
		children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
			style: {
				width: "100%",
				maxWidth: 960,
				display: "flex",
				flexDirection: "column",
				gap: 20
			},
			children: [
				/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					style: {
						display: "flex",
						alignItems: "center",
						gap: 12
					},
					children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(HubGlyph, { size: 36 }), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						style: { minWidth: 0 },
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h1", {
							style: {
								margin: 0,
								fontSize: 20,
								fontWeight: 500,
								lineHeight: "28px"
							},
							children: "Hub"
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
							style: {
								margin: "2px 0 0",
								fontSize: 13,
								lineHeight: "20px",
								color: "var(--dsw-alias-label-secondary)"
							},
							children: "Multi-agent across machines in one hub by SuperD"
						})]
					})]
				}),
				/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
					style: {
						display: "flex",
						gap: 4,
						borderBottom: "1px solid var(--dsw-alias-border-l3)"
					},
					children: [
						["home", "Home"],
						["workflows", "Workflows"],
						["settings", "Settings"]
					].map(([id, label]) => {
						const active = tab === id;
						return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
							type: "button",
							onClick: () => {
								setTab(id);
							},
							style: {
								padding: "8px 10px",
								border: "none",
								background: "transparent",
								font: "inherit",
								fontSize: 13,
								fontWeight: active ? 500 : 400,
								color: active ? "var(--dsw-alias-label-primary)" : "var(--dsw-alias-label-secondary)",
								borderBottom: `2px solid ${active ? "var(--dsw-alias-brand-primary)" : "transparent"}`,
								marginBottom: -1,
								cursor: "pointer"
							},
							children: label
						}, id);
					})
				}),
				tab === "workflows" && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("section", {
					style: {
						display: "flex",
						flexDirection: "column",
						gap: 8
					},
					children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(GroupHead, {
						title: "Workflows",
						count: 0
					}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						style: {
							margin: 0,
							fontSize: 13,
							lineHeight: "20px",
							color: "var(--dsw-alias-label-tertiary)"
						},
						children: "Orchestration across the machines and runtimes above — workflow authoring lands with the hub service."
					})]
				}),
				tab === "settings" && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("section", {
					style: {
						display: "flex",
						flexDirection: "column",
						gap: 8
					},
					children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(GroupHead, {
						title: "Settings",
						count: 0
					}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						style: {
							margin: 0,
							fontSize: 13,
							lineHeight: "20px",
							color: "var(--dsw-alias-label-tertiary)"
						},
						children: "Hub preferences — pairing, runtime visibility, and orchestration defaults land with the hub service."
					})]
				}),
				tab === "home" && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("section", {
					style: {
						display: "flex",
						flexDirection: "column",
						gap: 8
					},
					children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)(GroupHead, {
							title: "Machines",
							count: machines.length,
							action: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
								type: "button",
								onClick: () => {
									setShowAdd((value) => !value);
								},
								style: {
									display: "inline-flex",
									alignItems: "center",
									gap: 6,
									padding: "5px 10px",
									borderRadius: 8,
									border: "none",
									background: "transparent",
									color: "var(--dsw-alias-label-secondary)",
									font: "inherit",
									fontSize: 12.5,
									cursor: "pointer"
								},
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("svg", {
									width: "11",
									height: "11",
									viewBox: "0 0 11 11",
									fill: "none",
									"aria-hidden": "true",
									children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", {
										d: "M5.5 1.5V9.5M1.5 5.5H9.5",
										stroke: "currentColor",
										strokeWidth: "1.4",
										strokeLinecap: "round"
									})
								}), "Add machine"]
							})
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
							style: {
								margin: 0,
								fontSize: 13,
								lineHeight: "20px",
								color: "var(--dsw-alias-label-tertiary)"
							},
							children: "Add another DSH from remote machines, provide the token URL."
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("ul", {
							style: listStyle,
							children: machines.map((machine) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(HoverRow, { children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									"aria-hidden": true,
									style: {
										width: 8,
										height: 8,
										borderRadius: "50%",
										flex: "none",
										background: machine.self ? "var(--dsw-alias-state-success-primary)" : "var(--dsw-alias-label-caption)"
									}
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									style: {
										fontWeight: 500,
										whiteSpace: "nowrap"
									},
									children: machine.name
								}),
								machine.label !== machine.name && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									style: chip,
									children: machine.label
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									style: {
										flex: 1,
										minWidth: 0,
										overflow: "hidden",
										textOverflow: "ellipsis",
										whiteSpace: "nowrap",
										fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
										fontSize: 12,
										color: "var(--dsw-alias-label-secondary)"
									},
									children: machine.url
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									style: machine.self ? chipSelf : chipPending,
									children: machine.self ? "self" : "link pending"
								}),
								!machine.self && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
									type: "button",
									"aria-label": `Remove ${machine.name}`,
									onClick: () => {
										removeMachine(machine.id);
									},
									style: {
										display: "inline-flex",
										alignItems: "center",
										justifyContent: "center",
										width: 22,
										height: 22,
										borderRadius: 6,
										border: "none",
										background: "transparent",
										color: "var(--dsw-alias-label-caption)",
										font: "inherit",
										cursor: "pointer"
									},
									children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("svg", {
										width: "11",
										height: "11",
										viewBox: "0 0 11 11",
										fill: "none",
										"aria-hidden": "true",
										children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", {
											d: "M2.5 2.5L8.5 8.5M8.5 2.5L2.5 8.5",
											stroke: "currentColor",
											strokeWidth: "1.4",
											strokeLinecap: "round"
										})
									})
								})
							] }, machine.id))
						}),
						showAdd && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							style: {
								display: "grid",
								gridTemplateColumns: "0.5fr 1.4fr",
								gap: 10,
								padding: 12,
								margin: "0 -8px",
								borderRadius: 12,
								border: "1px solid var(--dsw-alias-border-l3)"
							},
							children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									style: fieldLabel,
									children: "Name"
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
									style: inputStyle,
									value: draft.name,
									placeholder: "dev3",
									onChange: (event) => {
										setDraft({
											...draft,
											name: event.target.value
										});
									}
								})] }),
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									style: fieldLabel,
									children: "URL"
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
									style: inputStyle,
									value: draft.url,
									placeholder: "http://192.0.2.130:4999",
									onChange: (event) => {
										setDraft({
											...draft,
											url: event.target.value
										});
									}
								})] }),
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									style: {
										gridColumn: "1 / -1",
										display: "flex",
										gap: 8,
										justifyContent: "flex-end"
									},
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
										type: "button",
										onClick: () => {
											setShowAdd(false);
											setDraft(EMPTY_DRAFT);
										},
										style: {
											padding: "7px 14px",
											borderRadius: 8,
											border: "none",
											background: "transparent",
											color: "var(--dsw-alias-label-secondary)",
											font: "inherit",
											fontSize: 13,
											cursor: "pointer"
										},
										children: "Cancel"
									}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
										type: "button",
										disabled: !draftValid,
										onClick: () => {
											addMachine();
										},
										style: {
											padding: "7px 14px",
											borderRadius: 8,
											border: "none",
											background: "color-mix(in srgb, currentColor 16%, transparent)",
											color: "inherit",
											font: "inherit",
											fontSize: 13,
											fontWeight: 500,
											cursor: draftValid ? "pointer" : "default",
											opacity: draftValid ? 1 : .5
										},
										children: "Add machine"
									})]
								})
							]
						})
					]
				}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("section", {
					style: {
						display: "flex",
						flexDirection: "column",
						gap: 8
					},
					children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)(GroupHead, {
							title: "Agent Runtimes",
							count: agents?.length ?? 0
						}),
						rosterFailed && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
							style: {
								margin: 0,
								fontSize: 12.5,
								color: "var(--dsw-alias-state-warn-label, var(--dsw-alias-label-secondary))"
							},
							children: "Live roster unavailable — showing the last known list."
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("ul", {
							style: listStyle,
							children: [agents === null && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("li", {
								style: {
									padding: "9px 8px",
									fontSize: 13,
									color: "var(--dsw-alias-label-tertiary)",
									listStyle: "none"
								},
								children: "Loading roster…"
							}), agents?.map((agent) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(HoverRow, {
								clickable: fusion,
								onClick: fusion ? (event) => {
									rowDecision(agent, event);
								} : void 0,
								children: [
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)(RuntimeMark, {
										agentKey: agent.key,
										size: 20
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										style: {
											fontWeight: 500,
											whiteSpace: "nowrap"
										},
										children: agent.label
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										style: {
											flex: 1,
											minWidth: 0,
											overflow: "hidden",
											textOverflow: "ellipsis",
											whiteSpace: "nowrap",
											fontSize: 12.5,
											color: "var(--dsw-alias-label-tertiary)"
										},
										children: agent.machine ?? "local"
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										style: {
											...chip,
											fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
											fontSize: 10.5
										},
										children: displayPath(agent.path)
									}),
									isActive(agent) && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										style: chipSelf,
										children: "current"
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("a", {
										href: agent.path,
										"aria-current": isActive(agent) ? "page" : void 0,
										style: {
											fontSize: 12.5,
											color: "var(--dsw-alias-label-secondary)",
											textDecoration: "none"
										},
										onClick: fusion ? (event) => {
											event.stopPropagation();
											rowDecision(agent, event);
										} : void 0,
										children: fusion ? "switch" : "open"
									})
								]
							}, agent.key))]
						})
					]
				})] })
			]
		})
	});
}

//#endregion
//#region src/client/HubPanelIcon.tsx
function HubPanelIcon({ size }) {
	const wide = size <= 16;
	const rootRef = react.useRef(null);
	const menuRef = react.useRef(null);
	const [open, setOpen] = react.useState(false);
	const [box, setBox] = react.useState(null);
	const [agents, setAgents] = react.useState(() => rosterFromGlobal() ?? [NATIVE_LINK]);
	const fusion = fusionPage();
	const [activeKey, setActiveKey] = react.useState(() => fusion ? uiState()?.activeAgent : void 0);
	react.useEffect(() => {
		if (!fusion) return;
		const state = uiState();
		if (state === void 0) return;
		return state.subscribe((label) => {
			setActiveKey(label);
		});
	}, [fusion]);
	const measure = react.useCallback(() => {
		const row = rootRef.current?.closest("button") ?? null;
		if (row === null) {
			setBox(null);
			return;
		}
		const rect = row.getBoundingClientRect();
		setBox({
			top: rect.top,
			bottom: rect.bottom,
			left: rect.left,
			right: rect.right,
			width: rect.width
		});
	}, []);
	react.useLayoutEffect(() => {
		if (wide) measure();
	}, [wide, measure]);
	react.useEffect(() => {
		if (!open) return;
		let cancelled = false;
		measure();
		fetchRoster().then((list) => {
			if (!cancelled) setAgents(list);
		}).catch(() => {});
		const owns = (node) => rootRef.current !== null && rootRef.current.contains(node) || menuRef.current !== null && menuRef.current.contains(node);
		const onDown = (event) => {
			if (!owns(event.target)) setOpen(false);
		};
		const onKey = (event) => {
			if (event.key === "Escape") setOpen(false);
		};
		document.addEventListener("mousedown", onDown);
		document.addEventListener("keydown", onKey);
		window.addEventListener("resize", measure);
		return () => {
			cancelled = true;
			document.removeEventListener("mousedown", onDown);
			document.removeEventListener("keydown", onKey);
			window.removeEventListener("resize", measure);
		};
	}, [open, measure]);
	const here = currentMountPath();
	const isActive = (agent) => hubRowActive({
		fusion,
		agentKey: agent.key,
		agentPath: agent.path,
		activeAgent: activeKey,
		mountPath: here
	});
	const toggle = (event) => {
		event.stopPropagation();
		if (event.type !== "keydown") event.preventDefault();
		setOpen((value) => !value);
	};
	return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
		ref: rootRef,
		style: {
			position: "relative",
			display: "inline-flex",
			alignItems: "center",
			justifyContent: "center"
		},
		children: [
			/* @__PURE__ */ (0, react_jsx_runtime.jsx)(HubGlyph, { size }),
			wide && box !== null && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
				role: "button",
				tabIndex: 0,
				"aria-label": "Agent selector",
				"aria-expanded": open,
				title: "Agent selector",
				style: {
					position: "fixed",
					left: box.right - 24,
					top: box.top + (box.bottom - box.top) / 2,
					transform: "translateY(-50%)",
					display: "inline-flex",
					alignItems: "center",
					justifyContent: "center",
					width: 20,
					height: 20,
					borderRadius: 6,
					color: open ? "var(--dsw-alias-label-primary)" : "var(--dsw-alias-label-caption)",
					cursor: "pointer",
					zIndex: 50
				},
				onClick: toggle,
				onKeyDown: (event) => {
					if (event.key === "Enter" || event.key === " ") toggle(event);
				},
				children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("svg", {
					width: "10",
					height: "10",
					viewBox: "0 0 10 10",
					fill: "none",
					"aria-hidden": "true",
					children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", {
						d: "M2 3.6L5 6.4L8 3.6",
						stroke: "currentColor",
						strokeWidth: "1.4",
						strokeLinecap: "round",
						strokeLinejoin: "round"
					})
				})
			}),
			open && box !== null && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
				ref: menuRef,
				style: {
					position: "fixed",
					top: box.bottom + 6,
					left: box.left,
					width: box.width,
					zIndex: 60,
					background: "var(--dsh-surface, #26262b)",
					border: "1px solid color-mix(in srgb, currentColor 18%, transparent)",
					borderRadius: 10,
					boxShadow: "0 8px 24px rgba(0,0,0,.35)",
					overflow: "hidden",
					padding: 4,
					color: "var(--dsw-alias-label-primary)"
				},
				children: agents.map((agent) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("a", {
					href: agent.path,
					"aria-current": isActive(agent) ? "page" : void 0,
					onClick: (event) => {
						if (seatClickDecision({
							fusion,
							active: isActive(agent),
							attempt: () => attemptSwitch(agent.key)
						}).preventDefault) event.preventDefault();
						if (fusion) event.stopPropagation();
						setOpen(false);
					},
					style: {
						display: "flex",
						alignItems: "center",
						gap: 8,
						padding: "8px 10px",
						borderRadius: 7,
						textDecoration: "none",
						color: "inherit",
						fontSize: 13,
						background: isActive(agent) ? "color-mix(in srgb, currentColor 10%, transparent)" : "transparent"
					},
					children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						style: {
							flex: 1,
							textAlign: "left",
							whiteSpace: "nowrap",
							overflow: "hidden",
							textOverflow: "ellipsis"
						},
						children: agent.label
					}), isActive(agent) && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						"aria-hidden": true,
						children: "✓"
					})]
				}, agent.key))
			})
		]
	});
}

//#endregion
//#region src/client/index.ts
/** Required services (cordis fiber inject): the slot registry. */
const inject = ["slots"];
/**
* Mount the client surfaces. Degrades silently when the slot service is
* absent (a composition without the sidebar renders nothing — every seat
* here is an optional occupant by contract).
*
* @param ctx - client root context.
*/
function apply(ctx) {
	ctx.inject(["slots"], (raw) => {
		const scope = raw;
		scope.effect(() => scope.slots.inject("main", () => scope.slots.register({
			name: "main",
			key: "hub"
		}, HubPage)), "superd-hub: hub main panel");
		scope.effect(() => scope.slots.inject("sidebar.panellist", () => scope.slots.register({
			name: "sidebar.panellist",
			id: "hub",
			order: 1,
			label: "Hub"
		}, HubPanelIcon)), "superd-hub: hub sidebar row");
	});
	ctx.inject([
		"connection",
		"uiWorkspace",
		"workspaces"
	], (raw) => {
		bindSwitchAgent(raw);
	});
}

//#endregion
exports.apply = apply;
exports.inject = inject;
return module.exports; } });