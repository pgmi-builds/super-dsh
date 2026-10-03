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
let __deepseek_ai_dsh_client_ui_primitives = require("@deepseek-ai/dsh-client-ui-primitives");
__deepseek_ai_dsh_client_ui_primitives = __toESM(__deepseek_ai_dsh_client_ui_primitives);
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
	const base = agentKey.endsWith("-sdk") ? agentKey.slice(0, -4) : agentKey;
	const uri = RUNTIME_ICON_URIS[base];
	if (uri === void 0) return /* @__PURE__ */ (0, react_jsx_runtime.jsx)(SubagentGlyph, { size });
	const tile = RUNTIME_TILE_BG[base];
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
	path: "/",
	machine: "local",
	ready: true,
	failed: false
};
/** Labels for the read-only face's bare keys (it reports keys, not labels). */
const FALLBACK_LABELS = {
	native: "DSH",
	omp: "OMP",
	codex: "Codex",
	claude: "Claude",
	pi: "Pi",
	hermes: "Hermes",
	agy: "Antigravity",
	"omp-sdk": "OMP (SDK)",
	"agy-sdk": "Antigravity (SDK)",
	"codex-sdk": "Codex (SDK)"
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
			machine: typeof machine === "string" && machine !== "" ? machine : void 0,
			ready: entry.ready === true,
			failed: entry.failed === true
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
	const location$1 = globalThis.location;
	const pathname = location$1 === void 0 ? "/" : location$1.pathname;
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
				path: `/${key}/`,
				machine: "local",
				ready: key === "native"
			});
		}
		if (links.length > 0) return links;
	}
	throw new Error("agent-runtime face returned no roster");
}

//#endregion
//#region src/client/mesh-api.ts
/**
* Machine-mesh data access for the Hub machines panel (mesh P1, Task 5):
* the client half of `/api/superd/machines` (host side: mesh-rpc.ts) —
* same-origin fetch behind the standard browser-trust + cookie fence, the
* roster face's house style (`credentials: 'same-origin'`). The localStorage
* ledger era (machines-store.ts, retired with this module) ended: the hub's
* registry is the single source of truth, this file only fetches it and
* coerces the wire answer into row views.
*
* Node-safe by construction — no DOM, no react, no @deepseek-ai imports —
* so the host tsc emits it to `dist/client/mesh-api.js` and
* test/client-mesh-view.test.mjs runs the pure halves (coercion, token-URL
* pre-check) under `node --test` without jsdom: the switch-core/toast-core
* precedent in reverse (pure logic kept beside the fetch wrappers, all under
* src/client). No fetch happens at import time.
*
* @module superd-hub/client/mesh-api
*/
/**
* Base path of the mesh machines API — the client-side spelling of the
* host's `MESH_API_BASE` (mesh-rpc.ts). Duplicated deliberately: importing
* the host module would drag its node:fs-backed dependencies into the
* browser bundle; a path literal cannot drift silently because the mesh-rpc
* route registration and this file are reviewed together.
*/
const MESH_API_BASE = "/api/superd/machines";
/** The statuses the wire may carry; anything else coerces to `'pending'`. */
const STATUSES = [
	"pending",
	"reachable",
	"unreachable",
	"auth-expired"
];
/** Coerce the self block; a shape without a non-empty string id + string label is simply absent. */
function coerceSelf(raw) {
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return void 0;
	const { id, label } = raw;
	if (typeof id !== "string" || id === "" || typeof label !== "string") return void 0;
	return {
		id,
		label
	};
}
/**
* Coerce a raw GET body into the panel's view list. Any bad shape degrades
* to the empty list (rows dropped individually, self dropped as a block) —
* the UI never crashes on a malformed answer.
*
* @param raw - the parsed JSON body (or anything else the wire produced).
* @returns self (when usable) + the coerced remote rows.
*/
function coerceMachineList(raw) {
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return { machines: [] };
	const record = raw;
	const self = coerceSelf(record.self);
	const machines = [];
	if (Array.isArray(record.machines)) for (const entry of record.machines) {
		if (typeof entry !== "object" || entry === null || Array.isArray(entry)) continue;
		const row = entry;
		if (typeof row.id !== "string" || row.id === "") continue;
		if (typeof row.name !== "string" || row.name === "") continue;
		if (typeof row.origin !== "string" || row.origin === "") continue;
		const status = typeof row.status === "string" && STATUSES.includes(row.status) ? row.status : "pending";
		const base = {
			id: row.id,
			name: row.name,
			label: typeof row.label === "string" && row.label !== "" ? row.label : row.name,
			origin: row.origin,
			status,
			self: self !== void 0 && row.id === self.id
		};
		const withProbe = typeof row.lastProbeAt === "number" ? {
			...base,
			lastProbeAt: row.lastProbeAt
		} : base;
		machines.push(typeof row.versionWarning === "string" && row.versionWarning !== "" ? {
			...withProbe,
			versionWarning: row.versionWarning
		} : withProbe);
	}
	return self === void 0 ? { machines } : {
		self,
		machines
	};
}
/**
* The version-warning chip for one machine row (I2): present EXACTLY when the
* coerced row carries a `versionWarning` — the Hub machines panel renders
* the chip iff this returns a value. Kept here beside the coercion so the
* presence contract stays unit-testable without jsdom (the HubPage seat is
* a one-line consumer following the existing chip patterns).
*/
function machineVersionChip(machine) {
	return machine.versionWarning === void 0 ? void 0 : { text: machine.versionWarning };
}
/** Read a non-2xx body's `{error}` message; degrade to the bare status line. */
async function errorText(response) {
	try {
		const body = await response.json();
		if (typeof body?.error === "string" && body.error !== "") return body.error;
	} catch {}
	return `HTTP ${response.status}`;
}
/**
* GET the machine list (self + remotes).
*
* @returns the coerced list — a malformed body degrades to the empty list, never a throw.
* @throws when the request fails or the face answers non-2xx.
*/
async function fetchMachines() {
	const response = await fetch(MESH_API_BASE, { credentials: "same-origin" });
	if (!response.ok) throw new Error(await errorText(response));
	return coerceMachineList(await response.json().catch(() => void 0));
}
/**
* POST a pairing `{name, label?, tokenUrl}` (label omitted → the server
* collapses it to the name).
*
* @throws Error(body.error) when the face answers non-2xx — the message is
* mesh-link's own, already token-redacted.
*/
async function addMachine(input) {
	const body = {
		name: input.name,
		tokenUrl: input.tokenUrl
	};
	if (typeof input.label === "string" && input.label !== "") body.label = input.label;
	const response = await fetch(MESH_API_BASE, {
		credentials: "same-origin",
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body)
	});
	if (!response.ok) throw new Error(await errorText(response));
}
/**
* DELETE one remote row by id (`{removed: boolean}` answers even for
* unknown ids — a false removal is a reload, not an error).
*
* @throws Error(body.error) on a non-2xx answer.
*/
async function removeMachine(id) {
	const response = await fetch(`${MESH_API_BASE}?id=${encodeURIComponent(id)}`, {
		credentials: "same-origin",
		method: "DELETE"
	});
	if (!response.ok) throw new Error(await errorText(response));
}
/**
* POST `{op: 'reprobe', id}` — a fresh probe of one remote; the outcome
* (even unreachable/auth-expired) lands in the status table server-side, so
* the caller reloads rather than interpreting the probe body.
*
* @throws Error(body.error) on a non-2xx answer (the op itself failed).
*/
async function reprobeMachine(id) {
	const response = await fetch(MESH_API_BASE, {
		credentials: "same-origin",
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			op: "reprobe",
			id
		})
	});
	if (!response.ok) throw new Error(await errorText(response));
}
/**
* The standing cadence note (D18): machine status refresh rides the hub's
* 5-minute sweep — the panel renders this verbatim beside its live-fetch
* control. English copy to match the DSH UI.
*/
const AUTO_REFRESH_NOTE = "auto-refreshes every 5 min";
/**
* The per-machine last-fetch line, shaped from the row's `lastProbeAt`
* (the hub's status table stamp — mesh-rpc joins it on every GET).
* Pure by design (the UI passes its own `now`): headless-testable without
* jsdom, same presence contract as {@link machineVersionChip} — absent or
* non-finite stamp means "never probed" and the panel omits the line.
*
* @param lastProbeAt - epoch ms of the machine's last recorded probe.
* @param now - epoch ms the panel renders at.
* @returns "Updated 2m ago" / "Updated just now" / … , or undefined.
*/
function lastFetchLabel(lastProbeAt, now) {
	if (typeof lastProbeAt !== "number" || !Number.isFinite(lastProbeAt)) return void 0;
	const seconds = Math.max(0, Math.floor((now - lastProbeAt) / 1e3));
	if (seconds < 60) return "Updated just now";
	if (seconds < 3600) return `Updated ${Math.floor(seconds / 60)}m ago`;
	if (seconds < 86400) return `Updated ${Math.floor(seconds / 3600)}h ago`;
	return `Updated ${Math.floor(seconds / 86400)}d ago`;
}
/**
* Client-side pre-check before a pairing submit: a parseable absolute
* http(s) URL carrying a non-empty `token` query param. The server re-parses
* authoritatively (mesh-link's parseTokenUrl); this only keeps obviously
* dead drafts off the wire.
*
* @param input - the raw token-URL draft (trim before calling).
* @returns whether the draft is submit-shaped.
*/
function validTokenUrl(input) {
	if (typeof input !== "string" || input === "") return false;
	let url;
	try {
		url = new URL(input);
	} catch {
		return false;
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") return false;
	const token = url.searchParams.get("token");
	return token !== null && token !== "";
}

//#endregion
//#region src/client/mesh-groups.ts
/** The machine key every LOCAL roster row carries (older host shapes may omit the field — grouping treats absent as local). */
const LOCAL_MACHINE_KEY = "local";
/** The LOCAL section's fixed display label — this machine needs no registry row to be named. */
const LOCAL_MACHINE_LABEL = "This machine";
/** Whether a row's machine field parks it in the local section: `'local'` or absent (the coercion drops unknown values). */
function isLocalMachine(machine) {
	return machine === void 0 || machine === LOCAL_MACHINE_KEY;
}
/**
* Group a roster into machine sections for the switch menu and the Hub
* roster rows: the LOCAL group first (label {@link LOCAL_MACHINE_LABEL};
* rows whose `machine` is `'local'` or absent), then one group per remote
* machine sorted by display label (code-unit order) with the machine key as
* the tiebreak. Members keep the roster's given order inside their group;
* groups only exist for machines actually present in the roster (no empty
* local section when every row is federated). An unknown label map entry —
* missing, or an empty string — falls back to the raw machine key.
*
* @param links - the roster rows (any order; the section order is derived, not inherited).
* @param machineLabels - machine key (m4) → display label; the machines API answer via {@link machineLabelsFrom}.
* @returns the sections, local first.
*/
function groupByMachine(links, machineLabels) {
	const local = [];
	const byKey = /* @__PURE__ */ new Map();
	for (const link of links) {
		if (isLocalMachine(link.machine)) {
			local.push(link);
			continue;
		}
		const machine = link.machine;
		const bucket = byKey.get(machine);
		if (bucket === void 0) byKey.set(machine, [link]);
		else bucket.push(link);
	}
	const labelOf = (key) => {
		const label = machineLabels[key];
		return typeof label === "string" && label !== "" ? label : key;
	};
	const remote = [...byKey.entries()].map(([key, agents]) => ({
		key,
		label: labelOf(key),
		agents
	})).sort((a, b) => a.label !== b.label ? a.label < b.label ? -1 : 1 : a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
	return local.length > 0 ? [{
		key: LOCAL_MACHINE_KEY,
		label: LOCAL_MACHINE_LABEL,
		agents: local
	}, ...remote] : remote;
}
/**
* The machines API answer → the grouping label map: every remote row's
* `id → label` (mesh-api's coercion already collapsed an empty label to the
* machine name) plus the self block's own `m4 → label`. An absent list is
* the empty map — the caller's degrade-to-flat trigger, never a throw.
*
* @param list - the coerced `fetchMachines()` answer, when it succeeded.
* @returns machine key → display label (the raw key stays absent, not mapped).
*/
function machineLabelsFrom(list) {
	const labels = {};
	if (list === void 0) return labels;
	for (const machine of list.machines) labels[machine.id] = machine.label !== "" ? machine.label : machine.name;
	if (list.self !== void 0) labels[list.self.id] = list.self.label;
	return labels;
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
* Orchestration sequence (spec §3.5 as amended 2026-09-26, T-A + T-F
* errata; user rulings 7/8 and the T-F ruling "按原生的语义去理解…把这个
* last visit session 也做一下"):
*   1. `setAgent(label)` — state + NS swap immediately; subsequent requests
*      demux to the target world (Task 3's call-time patches read the atom).
*   2. `reconnect()` — the generation re-opens against the retargeted data
*      plane; the gateway emits `connection/reset` on establishment, the
*      designed "wire-derived caches must repull" signal, so sessions /
*      config / theme re-derive on their own. Nothing navigates before the
*      repull: the chat area is never cleared and no loading skeleton is
*      inserted — old content stays in place awaiting the landing.
*   3. Session landing (T-F: NATIVE restore semantics) — upstream's
*      fresh-load restore is `watchNavigation`/`restoreSelection`
*      (navigation.ts:284-347): it fires only when BOTH `workspaces.list`
*      and `sessions.list` reached phase `'ready'`, and then walks
*      `saved.subagentAddress` → `saved.sessionId` looked up in the FRESH
*      `sessions.byId` (stale-proof) → recent-workspace → the fresh-boot
*      default workspace. The landing replicates exactly that: it fires once
*      when BOTH wire-derived caches have installed fresh post-establishment
*      baselines ({@link observeCachesRefreshed} — the T-A gate watched
*      `workspaces.list` alone, so a plane whose sessions list landed later
*      served stale rows to the decision and broke native's own
*      last-visited restore; T-G additionally holds the gate while a
*      persisted pointer has not yet joined the freshly minted INCREMENTAL
*      sessions list — membership via `byId` — firing on membership or on
*      the quiet-window ladder, {@link LANDING_QUIET_MS}, so partial-list
*      first edges stop laddering every switch into a brand-new session),
*      then reads the target NS's persisted
*      `dsh.sessions.current` (the NS swap has long since happened) and
*      executes {@link planRestoreLanding}'s precedence through the public
*      faces. The landing is BOUNDED: if the baselines never install within
*      one further fallback window after the settle, a staleness watchdog
*      disarms it — an armed landing never outlives its switch by more than
*      that window (the safe direction: no landing at all beats a late
*      surprise navigation).
*   4. Fallback: no generation within {@link SWITCH_FALLBACK_MS}, or a failed
*      roster probe → `setAgent('native')` + `reconnect()` back to the native
*      plane + toast. A revert also cancels a pending landing — a
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
*   - `uiWorkspace.openSession(target)` / `startSession(workspaceId?)` /
*     `openWorkspace(workspaceId)` — the navigation face
*     (`packages/client/ui-workspace/src/client/navigation.ts:34-92`);
*     `SessionTarget = SessionId | SubagentAddress`
*     (`packages/api/session-controller/src/client/contract/sessions.ts:22`).
*   - `watchNavigation` / `restoreSelection` — the fresh-load restore this
*     landing replicates (`navigation.ts:284-347`): both-lists ready gate
*     (:292), `subagentAddress` first (:320-323), the fresh-`byId` session
*     lookup with the blank-reuse nuance (:324-335), `recentWorkspace`
*     fallback (:337, the tie-break at :434-453), and
*     `initializeDefaultWorkspace` on a fresh boot (:338-342, :349-361).
*   - `startSession()`'s workspace resolution — `workspaceId ??
*     currentWorkspaceId ?? recent` over the wire-derived `workspaces.list`
*     / `sessions.list` snapshots (`navigation.ts:223-238`); `connectWorkspace`
*     → `reuseOrCreateBlank` reuses the pointer's own blank whenever the
*     private restore path would (:179-198).
*   - The wire-derived stores: `workspaces.list` installs fresh data only
*     through its follow-stream baseline (`packages/api/workspace-controller/src/client/model.ts`
*     `replaceBaseline` → `installViews`, a new items array every install);
*     `sessions.list` is projected with a fresh `ids` array on every manager
*     change (`packages/api/session-controller/src/client/sessions/service.ts:607-677`)
*     — array identity is the freshness token for both.
*   - `dsh.sessions.current` — the per-tab last-selection store
*     (`navigation.ts:130-131`); its restore reads `subagentAddress` first,
*     then `sessionId` (`navigation.ts:319-330`) — {@link parseLandingTarget}
*     keeps that precedence. The store hydrates once at page boot and
*     persists on write (`packages/client/store/src/index.ts:155-174`), so
*     the landing read must go through the namespaced `Storage` (Task 3
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
* The membership-wait quiet window (T-G): after both navigation caches are
* fresh, a persisted pointer the sessions list has not shown yet holds the
* landing gate — the list is minted INCREMENTALLY post-reconnect (upstream
* `handleSessionAdded` applies one session at a time, each application
* re-projecting the store with a fresh `ids` array, service.ts:677), so the
* first fresh edge sees a partial `byId` that legitimately lacks the
* pointer's session. The gate fires on membership; while the pointer is
* still absent, this window of list SILENCE (no `ids` identity change) is
* the concession point: the gate fires anyway and the plan takes the ladder
* — an honest miss, because a stored blank pointer legitimately never
* appears (matching upstream's own boot restore of a stale/absent id). An
* identity change during the window restarts it (the list is still growing).
* The machine's post-settle staleness watchdog remains the hard bound on
* the whole wait.
*/
const LANDING_QUIET_MS = 600;
/**
* The persisted-selection parse feeding {@link planRestoreLanding}.
*
* A value is navigable when it parses to a ui-workspace `MainSelection`
* carrying a usable `SessionTarget`: a non-null `subagentAddress` object
* wins (upstream restore order), else a non-empty string `sessionId`.
* Everything else — no value, a read failure (surfaced here as `null`), a
* parse failure, an unusable shape — parses to `null` and the plan falls to
* the recent-workspace / default-workspace ladder.
*
* @returns the subagent address object, the session id string, or `null`.
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
* The most-recent workspace per upstream `recentWorkspace`
* (navigation.ts:434-453): the latest member-session `updatedAt` wins, a
* workspace with no listed sessions falls back to its `createdAt`.
*/
function recentWorkspaceId(items, byId) {
	let selected;
	let selectedTime = Number.NEGATIVE_INFINITY;
	for (const workspace of items) {
		let latest = Number.NEGATIVE_INFINITY;
		for (const sessionId of workspace.sessionIds) {
			const session = byId[sessionId];
			if (session !== void 0 && typeof session.updatedAt === "number") latest = Math.max(latest, session.updatedAt);
		}
		if (latest === Number.NEGATIVE_INFINITY && workspace.createdAt !== void 0) latest = Date.parse(workspace.createdAt);
		if (selected === void 0 || latest > selectedTime) {
			selected = workspace.workspaceId;
			selectedTime = latest;
		}
	}
	return selected;
}
/**
* The landing decision with NATIVE restore semantics (T-F): replicate
* upstream `restoreSelection` (navigation.ts:318-347) against the fresh
* caches and the parsed persisted selection ({@link parseLandingTarget}'s
* result, which already applies the `subagentAddress`-first precedence).
*
*   - `subagentAddress` → open it directly, no cache consultation
*     (navigation.ts:320-323).
*   - `sessionId` found in the FRESH `byId`: non-blank — or blank but
*     workspace-less — opens the id (navigation.ts:324-329); blank with a
*     workspace resolves to that workspace (navigation.ts:333-335's private
*     `reuseBlank` + :337's `workspace.workspaceId` target — the public
*     `startSession(workspaceId)` face covers both: its `connectWorkspace`
*     → `reuseOrCreateBlank` reuses the pointer's own blank whenever the
*     private pre-check would pass, because the eligibility scan is the
*     same).
*   - A stale id (absent from the fresh `byId`) falls through to the
*     no-pointer ladder exactly as upstream's `summary === undefined` does.
*   - No pointer / stale pointer: the recent workspace gets the new-session
*     flow (navigation.ts:337); both lists empty is the fresh boot and
*     mirrors `initializeDefaultWorkspace` (navigation.ts:338-342).
*   - `caches` unavailable (the host's read failed) → `undefined`: land
*     nothing — no landing beats a wrong one. Same for the degenerate
*     zero-workspaces-with-sessions shape, where upstream simply leaves the
*     view as it is (no target, both-empty guard false, :337-342).
*
* @param parsed - the persisted-selection parse ({@link parseLandingTarget}).
* @param caches - the fresh both-lists snapshots, or `undefined` unreadable.
* @returns the action to execute, or `undefined` to land nothing.
*/
function planRestoreLanding(parsed, caches) {
	if (caches === void 0) return void 0;
	if (parsed !== null && typeof parsed === "object") return {
		kind: "open-session",
		target: parsed
	};
	if (typeof parsed === "string" && parsed !== "") {
		const summary = caches.sessions.byId[parsed];
		if (summary !== void 0) {
			const workspace = caches.workspaces.items.find((item) => item.sessionIds.includes(parsed));
			if (summary.blank !== true || workspace === void 0) return {
				kind: "open-session",
				target: parsed
			};
			return {
				kind: "start-session",
				workspaceId: workspace.workspaceId
			};
		}
	}
	const target = recentWorkspaceId(caches.workspaces.items, caches.sessions.byId);
	if (target !== void 0) return {
		kind: "start-session",
		workspaceId: target
	};
	if (caches.workspaces.items.length === 0 && caches.sessions.ids.length === 0) return { kind: "default-workspace" };
}
/**
* The caches-fresh gate behind the deferred landing (T-F; T-G made it
* pointer-membership-aware): fires `listener` AT MOST once, when BOTH
* navigation caches demonstrably hold the TARGET plane's data — the
* client-face equivalent of upstream's both-lists ready gate
* (`watchNavigation`, navigation.ts:292: `workspace.phase !== 'ready'
* || sessions.phase !== 'ready'` → return).
*
* The freshness token is each snapshot's `items` ARRAY IDENTITY: upstream's
* workspace model mints a new array on every baseline install
* (`installViews` → `[...installed.values()]`, model.ts:398) and the session
* list projection mints a fresh `ids` array on every manager change
* (service.ts:607-677), while carrier churn keeps references. The gate arms
* at the first generation establishment OBSERVED BY ITS OWN subscription —
* the anchors are retaken there, and nothing before that point can pass, so
* the dying old plane's last increments racing the reconnect are absorbed;
* the first replacements after establishment are the target plane's
* baselines. The `phase === 'ready'` checks ride along as a guard against a
* page whose first baseline never arrived. Both edges are tracked
* independently, in either arrival order (the T-A gap: watching workspaces
* alone let a late sessions baseline leave the pointer lookup reading stale
* `byId` rows).
*
* T-G — the pointer holds the gate. The sessions list is minted
* INCREMENTALLY after the reconnect (one `handleSessionAdded` per session,
* each re-projecting the store with a fresh `ids` array), so the first fresh
* edge sees a partial `byId` that legitimately lacks the pointer's session;
* consuming the landing there laddered every switch into a brand-new
* session (the browser-proven defect). When a pointer exists (the injected
* {@link LandingGateOptions.pointerSessionId} face, read at decision time),
* the gate therefore does NOT fire on the first fresh edge. It fires when:
*   - the sessions list CONTAINS the pointer's session — the membership
*     face (`byId`, consulted on EVERY sessions notification: `byId` can
*     gain a row without a new `ids` identity, service.ts:565), or
*   - the sessions list has gone QUIET — no `ids` identity change for the
*     configured quiet window ({@link LANDING_QUIET_MS}; an identity change
*     during the window restarts it) while the pointer is still absent:
*     the honest miss, firing with the ladder exactly like upstream's boot
*     restore of a stored id its fresh list does not know.
* No pointer → the first fresh edge fires, byte-identical to T-F (the
* fresh-boot path). The machine's post-settle staleness watchdog bounds the
* whole membership wait: it disposes this gate, which also cancels a
* running quiet window.
*
* Establishment strictly precedes any target-plane baseline (the follow
* streams re-open on top of the established generation), so a fire implies
* both "generation established" and "repull landed" — the two preconditions
* of a correct landing resolution.
*
* Host-half pure logic: the client binding composes it with the real
* `ctx.workspaces.list` + `ctx.sessions.list` stores and the connection
* generation observable; the machine consumes it through
* {@link SwitchHost.onCachesRefreshed}.
*
* @returns the disposer stopping all three subscriptions (and the quiet window).
*/
function observeCachesRefreshed(workspaces, sessions, generation, listener, gate = {}) {
	let established = false;
	let fired = false;
	let workspacesAnchor = workspaces.getSnapshot().items;
	let sessionsAnchor = sessions.getSnapshot().items;
	let workspacesFresh = false;
	let sessionsFresh = false;
	let quietTimer;
	const quietMs = gate.quietMs ?? LANDING_QUIET_MS;
	const clearQuiet = () => {
		if (quietTimer === void 0) return;
		if (gate.clearTimeout !== void 0) gate.clearTimeout(quietTimer);
		quietTimer = void 0;
	};
	const fire = () => {
		if (fired) return;
		fired = true;
		clearQuiet();
		listener();
	};
	const pointerSessionId = () => {
		try {
			return gate.pointerSessionId?.();
		} catch {
			return;
		}
	};
	/**
	* The decision point, run on every workspaces/sessions notification once
	* establishment happened. `sessionsIdentityChanged` distinguishes a real
	* list growth (restarts the quiet window) from a same-identity
	* notification like publishRetention's byId-only set (consults
	* membership, must NOT restart the window).
	*/
	const check = (sessionsIdentityChanged) => {
		if (fired || !established || !workspacesFresh || !sessionsFresh) return;
		const pointer = pointerSessionId();
		if (pointer === void 0) {
			fire();
			return;
		}
		if (sessions.contains?.(pointer)) {
			fire();
			return;
		}
		if (sessionsIdentityChanged || quietTimer === void 0) {
			clearQuiet();
			if (gate.setTimeout !== void 0) quietTimer = gate.setTimeout(() => {
				quietTimer = void 0;
				fire();
			}, quietMs);
		}
	};
	const disposeGeneration = generation.subscribe(() => {
		if (generation.getSnapshot() === void 0) return;
		established = true;
		workspacesFresh = false;
		sessionsFresh = false;
		clearQuiet();
		workspacesAnchor = workspaces.getSnapshot().items;
		sessionsAnchor = sessions.getSnapshot().items;
	});
	const disposeWorkspaces = workspaces.subscribe(() => {
		if (!established) return;
		const snapshot = workspaces.getSnapshot();
		if (snapshot.phase === "ready" && snapshot.items !== workspacesAnchor) workspacesFresh = true;
		check(false);
	});
	const disposeSessions = sessions.subscribe(() => {
		if (!established) return;
		const snapshot = sessions.getSnapshot();
		let identityChanged = false;
		if (snapshot.phase === "ready" && snapshot.items !== sessionsAnchor) {
			sessionsFresh = true;
			identityChanged = true;
			sessionsAnchor = snapshot.items;
		}
		check(identityChanged);
	});
	return () => {
		clearQuiet();
		disposeWorkspaces();
		disposeSessions();
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
*   - Non-fusion page (flag off; the UI's navigation arm is retired since
*     T-C): the mount path is the selection — the entry whose path equals
*     the page's normalized mount. The pure arm survives as contract; no
*     served page can hit the foreign case anymore.
*
* Host-half pure logic so `test/client-switch.test.mjs` pins it from `dist/`.
*/
function hubRowActive(input) {
	if (input.fusion) return input.agentKey === input.activeAgent;
	return input.agentPath === input.mountPath;
}
/** The degradation hint a Hub UI surface shows while the flag is off (T-E). */
const FUSION_OFF_HINT = "fusion off — no foreign entry";
/**
* The flag-off shape of the Hub UI switch surfaces (path-separation Part 2
* T-E closeout). With the per-label URL family retired (T-C) and the world
* web UIs disabled (T-D), a flag-OFF ctx0 page has NO foreign entry at all —
* and since T-C the Hub UI ships no hyperlinks either, so the smallest honest
* rendering is an inert roster with a visible degradation hint instead of a
* silently dead control:
*
*   - `available: true` (fusion page): the affordance renders — the HubPage
*     `switch` action and the HubPanelIcon chevron menu.
*   - `available: false` (flag off): the affordance is NOT rendered; the
*     roster stays informational and the surface shows the degradation hint
*     ({@link FUSION_OFF_HINT}) once (HubPage: a single chip under the
*     section head, not one per row). Nothing navigates — there is
*     nothing to navigate to.
*
* Host-half pure logic so `test/client-switch.test.mjs` pins it from `dist/`.
*/
function switchAffordance(fusion) {
	return fusion ? {
		available: true,
		hint: ""
	} : {
		available: false,
		hint: FUSION_OFF_HINT
	};
}
/**
* The active agent's display name for the Hub row's right-edge selector: the
* roster label of the atom's `activeAgent` key — the name the selector's
* `title` carries, since the row label itself is the constant `Hub`. A key the
* (seeded) roster does not know degrades to the raw key. `undefined`/empty
* (flag off, or no atom read) means "no active agent".
*
* Host-half pure logic so `test/client-switch.test.mjs` pins it from `dist/`.
*/
function activeAgentName(activeAgent, roster) {
	if (activeAgent === void 0 || activeAgent === "") return void 0;
	return roster.find((row) => row.key === activeAgent)?.label ?? activeAgent;
}
/**
* Build the switch machine over an injected {@link SwitchHost}.
*
* Only one attempt is ever armed at a time: starting a new switch finishes
* the previous one silently (timer cleared, subscription released, promise
* resolved) and cancels its pending landing, so a stale attempt can never
* revert or land over a newer switch. The landing cancel is held at
* CONTROLLER scope, not reached through the current-attempt pointer: the
* deferred landing deliberately survives the settle — which removes the
* attempt from `current` — so a supersede must still kill the armed landing
* of a PRIOR, ALREADY-SETTLED attempt (final-review round 2: without the
* controller-scope handle, a settled switch's landing fired over the newer
* switch's pointer-restored view).
*/
function createSwitchController(host, options = {}) {
	const fallbackMs = options.fallbackMs ?? SWITCH_FALLBACK_MS;
	const quietWindowMs = options.quietWindowMs ?? LANDING_QUIET_MS;
	let current$1;
	let armedLanding;
	return { run(label) {
		const prior = current$1;
		return new Promise((resolve) => {
			let timer;
			let watchdog;
			let disposer = () => {};
			let disposeLanding = () => {};
			let landingArmed = false;
			const cancelWatchdog = () => {
				if (watchdog === void 0) return;
				host.clearTimeout(watchdog);
				watchdog = void 0;
			};
			const attempt = {
				finished: false,
				dead: false,
				cancelLanding() {
					attempt.dead = true;
					landingArmed = false;
					disposeLanding();
					disposeLanding = () => {};
					cancelWatchdog();
				},
				finish() {
					if (attempt.finished) return;
					attempt.finished = true;
					host.clearTimeout(timer);
					disposer();
					if (current$1 === attempt) current$1 = void 0;
					if (landingArmed) watchdog = host.setTimeout(() => {
						attempt.cancelLanding();
					}, fallbackMs);
					resolve();
				}
			};
			if (armedLanding !== void 0) {
				const cancelPriorLanding = armedLanding;
				armedLanding = void 0;
				cancelPriorLanding();
			}
			if (prior !== void 0 && !prior.finished) prior.finish();
			current$1 = attempt;
			const revert = (reason) => {
				if (attempt.finished || current$1 !== attempt) return;
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
			try {
				host.reconnect();
			} catch {}
			timer = host.setTimeout(() => {
				revert("timeout");
			}, fallbackMs);
			disposer = host.onGenerationEstablished(() => {
				if (attempt.finished || current$1 !== attempt) return;
				attempt.finish();
			});
			landingArmed = true;
			const cancelThisLanding = () => {
				attempt.cancelLanding();
			};
			armedLanding = cancelThisLanding;
			const gateRequest = {
				pointerSessionId: () => {
					let parsed;
					try {
						parsed = parseLandingTarget(host.readPersistedSelection());
					} catch {
						return;
					}
					return typeof parsed === "string" && parsed !== "" ? parsed : void 0;
				},
				quietMs: quietWindowMs,
				setTimeout: (fn, ms) => host.setTimeout(fn, ms),
				clearTimeout: (handle) => host.clearTimeout(handle)
			};
			disposeLanding = host.onCachesRefreshed(() => {
				if (attempt.dead) return;
				if (armedLanding === cancelThisLanding) armedLanding = void 0;
				landingArmed = false;
				cancelWatchdog();
				disposeLanding();
				disposeLanding = () => {};
				let caches;
				try {
					caches = host.readRestoreCaches();
				} catch {
					caches = void 0;
				}
				let raw = null;
				try {
					raw = host.readPersistedSelection();
				} catch {
					raw = null;
				}
				const plan = planRestoreLanding(parseLandingTarget(raw), caches);
				if (plan === void 0) return;
				try {
					if (plan.kind === "open-session") host.openSession(plan.target);
					else if (plan.kind === "start-session") host.startSession(plan.workspaceId);
					else host.openDefaultWorkspace();
				} catch {}
			}, gateRequest);
			host.probeTarget(label).then((alive) => {
				if (alive !== true) revert("probe");
			}, () => {
				revert("probe");
			});
		});
	} };
}
/**
* The pure pre-flight decision. `native` always runs; an absent row (roster
* fetch failed, or the key is not listed) also runs — the machine's roster
* probe is the authority on unknown targets, exactly as before C1. A
* not-ready FEDERATED row (`machine` set and not `'local'`) decides
* `'machine-down'` — an immediate actionable failure, never a wait loop
* (the hub's probe already knows the machine is unreachable or its auth
* expired); `failed` keeps precedence everywhere (a peer-reported spawn
* rejection still reports as failed).
*/
function decidePreFlight(label, row) {
	if (label === NATIVE_AGENT) return "run";
	if (row === void 0) return "run";
	if (row.failed === true) return "failed";
	if (row.ready !== true) {
		if (row.machine !== void 0 && row.machine !== "local") return "machine-down";
		return "wait";
	}
	return "run";
}
/** Bound on the machine-down branch's enrichment fetch (mesh P3 Task 5a:
*  the parked P2 minor — an unbounded `fetchMachines` await — folds here; a
*  hung hub answer must never swallow the toast). */
const MACHINE_DOWN_ENRICH_MS = 3e3;
/**
* The machine-down branch's pure half (I1(c) feedback + I1(b) light probe,
* mesh P3 Task 5a): enrich the toast through the machines face — BOUNDED at
* {@link MACHINE_DOWN_ENRICH_MS} — then, after toasting, fire ONE reprobe
* for the row's machine and forget it: a stale-unreachable machine gets a
* fresh attempt per failed click, so the NEXT click can succeed without
* waiting for the hub's 5-minute sweep. Never blocks the UI path (the whole
* body is detached), never surfaces a reprobe failure (the sweep retries).
*/
function runMachineDownFeedback(label, row, faces) {
	(async () => {
		let machineName = row.machine;
		let status;
		const enriched = await new Promise((resolve) => {
			const bound$1 = faces.setTimeout(() => resolve(void 0), MACHINE_DOWN_ENRICH_MS);
			faces.fetchMachines().then((list) => {
				faces.clearTimeout(bound$1);
				resolve(list);
			}, () => {
				faces.clearTimeout(bound$1);
				resolve(void 0);
			});
		});
		if (enriched !== void 0) {
			const found = enriched.machines.find((entry) => entry.id === row.machine);
			if (found !== void 0) {
				machineName = found.label;
				if (found.status === "unreachable" || found.status === "auth-expired") status = found.status;
			}
		}
		const who = row.label ?? label;
		const machine = machineName ?? "its machine";
		faces.toast(status === void 0 ? `Super D: ${who} is unavailable — machine ${machine} is not ready. Reprobe or re-add it in the Hub machines panel.` : `Super D: ${who} is unavailable — machine ${machine} reports ${status}. Reprobe or re-add it in the Hub machines panel.`);
		if (row.machine !== void 0) faces.reprobe(row.machine).catch(() => {});
	})();
}
/** Default bound on one readiness wait (the page never locks behind a stuck world). */
const WAIT_BOUND_MS = 12e4;
/** Default poll interval for one readiness wait. */
const WAIT_POLL_MS = 1e3;
/**
* Build a bounded readiness waiter over injected faces. The poll re-reads
* the roster row every {@link ReadinessWaiterOptions.pollMs}; `failed`
* short-circuits immediately; the bound always terminates the wait.
*/
function createReadinessWaiter(faces, options = {}) {
	const boundMs = options.boundMs ?? WAIT_BOUND_MS;
	const pollMs = options.pollMs ?? WAIT_POLL_MS;
	let pending;
	let pollHandle;
	let boundHandle;
	let settled = false;
	const settle = (outcome) => {
		if (settled) return;
		settled = true;
		if (pollHandle !== void 0) faces.clearTimeout(pollHandle);
		if (boundHandle !== void 0) faces.clearTimeout(boundHandle);
		pending?.(outcome);
		pending = void 0;
	};
	return {
		wait(label) {
			return new Promise((resolve) => {
				pending = resolve;
				boundHandle = faces.setTimeout(() => {
					settle("bound");
				}, boundMs);
				const tick = () => {
					if (settled) return;
					faces.fetchRow().then((row) => {
						if (settled) return;
						if (row?.failed === true) {
							settle("failed");
							return;
						}
						if (row?.ready === true) {
							settle("ready");
							return;
						}
						pollHandle = faces.setTimeout(tick, pollMs);
					}, () => {
						if (!settled) pollHandle = faces.setTimeout(tick, pollMs);
					});
				};
				tick();
			});
		},
		cancel() {
			settle("cancelled");
		}
	};
}

//#endregion
//#region src/toast-core.ts
/** Failures that name what broke need a longer read than a one-liner. */
const TOAST_DEFAULT_HOLD_MS = 6e3;
/** The exact props the official primitive receives (pure — the unit seam). */
function toastProps(text, options = {}) {
	const props = {
		text,
		holdMs: options.holdMs ?? TOAST_DEFAULT_HOLD_MS
	};
	if (options.tone !== void 0) props.tone = options.tone;
	return props;
}
let seq = 0;
let current;
const listeners = /* @__PURE__ */ new Set();
function emit() {
	for (const fn of [...listeners]) try {
		fn(current);
	} catch {}
}
/** Fire one toast (best-effort: without a mounted owner nothing renders). */
function showSuperdToast(text, options = {}) {
	current = {
		seq: ++seq,
		text,
		options
	};
	emit();
}
/** Clear a shown toast (the fade's `onDone`); stale sequences are no-ops. */
function clearSuperdToast(done) {
	if (current === void 0 || current.seq !== done) return;
	current = void 0;
	emit();
}
/** Subscribe to the store (the host's effect face); returns unsubscribe. */
function onSuperdToast(fn) {
	listeners.add(fn);
	try {
		fn(current);
	} catch {}
	return () => {
		listeners.delete(fn);
	};
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
/**
* One transient message through the official `Toast` primitive (C1 task 4:
* the platform's top-center banner — dark surface in both themes, warn icon
* seat — rendered by the host's React tree from the Hub sidebar row's
* always-mounted owner; see client/toast.ts).
*/
function showToast(message) {
	showSuperdToast(message);
}
/**
* I1(c) feedback + I1(b) light probe (mesh P3 Task 5a): the machine-down
* branch delegates to the pure {@link runMachineDownFeedback} — the
* machines face (already part of the client half — the Hub machines panel's
* own cheap same-origin GET) enriches the toast, bounded at 3s; after
* toasting, ONE fire-and-forget reprobe POST per failed click refreshes the
* hub's status table so the NEXT click can succeed without waiting for the
* 5-minute sweep. Nothing here blocks the UI path.
*/
function reportMachineDown(label, row) {
	runMachineDownFeedback(label, row, {
		fetchMachines,
		reprobe: reprobeMachine,
		toast: showToast,
		setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
		clearTimeout: (handle) => globalThis.clearTimeout(handle)
	});
}
/**
* Build the `SwitchHost.openDefaultWorkspace` action.
*
* dsh 0.2.0-rc.2 removed the request object from the Host's
* `workspaces.initializeDefault` Remote: the first-use directory and stored
* title are fixed and language-neutral (`default-workspace` under
* `<Documents>/deepseek-harness`), so the caller passes only its own lifetime
* signal. This module shipped the pre-0.2 `{ directoryName, title }` shape for
* a release cycle; the Host then received a plain object where it feeds
* `AbortSignal.any(...)`, EVERY empty-plane landing rejected, and the browser
* surfaced "Unable to create default workspace". Root-caused 2026-10-02 on
* the Hermes world — the only world whose registry was still empty after the
* 0.2.0-rc.2 upgrade, hence the only one that took the default-workspace
* branch. Exported so the call shape is unit-testable without the
* module-level single-bind guard.
*
* @param deps - the workspace projection and the navigation face.
* @param toast - the feedback sink; a refusal is feedback, never a revert.
* @returns the host action.
*/
function openDefaultWorkspaceFor(deps, toast) {
	return () => {
		deps.workspaces.initializeDefault().then((prepared) => {
			if (prepared !== void 0) deps.uiWorkspace.openWorkspace(prepared.workspaceId);
		}).catch(() => {
			toast("Super D: unable to create the default workspace.");
		});
	};
}
/** The bound `switchAgent`, or `undefined` until the entry binds it. */
let bound;
/**
* Bind the page's switch agent from the client services. Idempotent; a no-op
* without the page atom (a non-fusion page never has one).
* @param deps - the `connection`, `uiWorkspace`, `workspaces` and `sessions`
*   services (structural; the stock client tree always has all four —
*   upstream's ui-workspace injects the same set).
*/
function bindSwitchAgent(deps) {
	if (bound !== void 0) return;
	const state = uiState();
	if (state === void 0) return;
	const readRestoreCaches = () => {
		const workspaces = deps.workspaces.list.getSnapshot();
		const sessions = deps.sessions.list.getSnapshot();
		return {
			workspaces: {
				items: workspaces.items,
				phase: workspaces.phase
			},
			sessions: {
				ids: sessions.ids,
				byId: sessions.byId,
				phase: sessions.phase
			}
		};
	};
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
		startSession(workspaceId) {
			deps.uiWorkspace.startSession(workspaceId);
		},
		openDefaultWorkspace: openDefaultWorkspaceFor(deps, showToast),
		readRestoreCaches,
		onCachesRefreshed(listener, gate) {
			return observeCachesRefreshed(deps.workspaces.list, {
				getSnapshot: () => {
					const snapshot = deps.sessions.list.getSnapshot();
					return {
						items: snapshot.ids,
						phase: snapshot.phase
					};
				},
				subscribe: (fn) => deps.sessions.list.subscribe(fn),
				contains: (id) => deps.sessions.list.getSnapshot().byId[id] !== void 0
			}, deps.connection.generation, listener, gate);
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
let pendingWait;
/**
* The Hub switch surfaces' entry point. Attempts the in-page switch for
* `label`, gated on the target world's readiness (C1): a not-ready world
* holds the UI on native with starting feedback and a bounded poll; a
* failed world reports and never switches; a ready/native/unknown target
* runs the machine (whose roster probe stays the fallback). A not-ready
* FEDERATED row skips all of that — an immediate machine-error toast
* (I1(c), `machine-down`), never a wait loop.
*
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
	pendingWait?.cancel();
	pendingWait = void 0;
	(async () => {
		let row;
		try {
			row = (await fetchRoster()).find((agent) => agent.key === label);
		} catch {
			row = void 0;
		}
		const decision = decidePreFlight(label, row);
		if (decision === "failed") {
			showToast(`Super D: ${label} failed to start — see the service log.`);
			return;
		}
		if (decision === "machine-down") {
			if (row !== void 0) reportMachineDown(label, row);
			return;
		}
		if (decision === "wait") {
			showToast(`Super D: ${label} is starting…`);
			const waiter = createReadinessWaiter({
				fetchRow: async () => {
					try {
						return (await fetchRoster()).find((agent) => agent.key === label);
					} catch {
						return;
					}
				},
				setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
				clearTimeout: (handle) => globalThis.clearTimeout(handle)
			});
			pendingWait = waiter;
			const outcome = await waiter.wait(label);
			if (pendingWait === waiter) pendingWait = void 0;
			if (outcome === "ready") {
				run(label).catch(() => {});
				return;
			}
			if (outcome === "failed") showToast(`Super D: ${label} failed to start — see the service log.`);
			else if (outcome === "bound") showToast(`Super D: ${label} is still starting — try again in a moment.`);
			return;
		}
		run(label).catch(() => {});
	})();
	return true;
}

//#endregion
//#region src/client/agent-settings.ts
const SETTINGS_PANELS = {
	agy: {
		namespace: "agyAuth",
		kind: "auth"
	},
	codex: {
		namespace: "codexProviders",
		kind: "providers"
	}
};
/** The panel spec for a runtime, or `undefined` when it has none yet. */
function settingsPanelFor(agentKey) {
	return SETTINGS_PANELS[agentKey];
}
/**
* Accordion transition: at most one row open. Clicking the open row closes it;
* clicking another moves the panel there in one click.
*/
function toggleExpanded(current$1, key) {
	return current$1 === key ? null : key;
}
function str(value) {
	return typeof value === "string" && value !== "" ? value : void 0;
}
function methodOption(raw) {
	if (typeof raw !== "object" || raw === null) return void 0;
	const record = raw;
	const key = str(record.key);
	const label = str(record.label);
	if (key === void 0 || label === void 0) return void 0;
	return {
		key,
		label,
		available: record.available === true,
		placeholder: record.placeholder === true,
		hint: str(record.hint) ?? ""
	};
}
/**
* Defensive parse of the RPC answer. Returns `undefined` for anything that is
* not a usable view (no methods, wrong shape, adapter absent) so the panel can
* render an explicit failure instead of an empty list that looks like success.
*/
function parseAuthView(raw) {
	if (typeof raw !== "object" || raw === null) return void 0;
	const record = raw;
	if (!Array.isArray(record.methods)) return void 0;
	const methods = record.methods.map(methodOption).filter((m) => m !== void 0);
	if (methods.length === 0) return void 0;
	const settingsPath = str(record.settingsPath);
	const note = str(record.note);
	return {
		methods,
		selected: str(record.selected) ?? null,
		effective: str(record.effective) ?? null,
		...settingsPath === void 0 ? {} : { settingsPath },
		...note === void 0 ? {} : { note }
	};
}
/**
* The option the panel marks as in force: the effective one when the adapter
* named it, else the explicit selection. `undefined` when neither is known —
* the panel then marks nothing rather than guessing.
*/
function activeMethod(view) {
	const wanted = view.effective ?? view.selected;
	if (wanted === null) return void 0;
	return view.methods.find((method) => method.key === wanted);
}
/** Whether an option may be picked (placeholders are rendered, never selected). */
function selectable(option) {
	return !option.placeholder;
}
function nonEmpty(value) {
	return typeof value === "string" && value !== "" ? value : void 0;
}
function modelOption(raw) {
	if (typeof raw !== "object" || raw === null) return void 0;
	const record = raw;
	const id = nonEmpty(record.id);
	if (id === void 0) return void 0;
	const contextWindow = record.contextWindow;
	return {
		id,
		label: nonEmpty(record.displayName) ?? id,
		...typeof contextWindow === "number" && Number.isSafeInteger(contextWindow) && contextWindow > 0 ? { contextWindow } : {}
	};
}
function providerOption(raw) {
	if (typeof raw !== "object" || raw === null) return void 0;
	const record = raw;
	const id = nonEmpty(record.id);
	const label = nonEmpty(record.label);
	const baseUrl = nonEmpty(record.baseUrl);
	if (id === void 0 || label === void 0 || baseUrl === void 0) return void 0;
	const models = Array.isArray(record.models) ? record.models.map(modelOption).filter((entry) => entry !== void 0) : [];
	const envName = nonEmpty(record.envName);
	return {
		id,
		label,
		baseUrl,
		protocol: record.protocol === "chat" ? "chat" : "responses",
		models,
		authKind: record.authKind === "env" ? "env" : "apiKey",
		...envName === void 0 ? {} : { envName },
		hasKey: record.hasKey === true
	};
}
function protocolOption(raw) {
	if (typeof raw !== "object" || raw === null) return void 0;
	const record = raw;
	const value = nonEmpty(record.value);
	const label = nonEmpty(record.label);
	if (value === void 0 || label === void 0) return void 0;
	return {
		value,
		label,
		available: record.available === true,
		hint: nonEmpty(record.hint) ?? ""
	};
}
function providerPaths(raw) {
	if (typeof raw !== "object" || raw === null) return void 0;
	const record = raw;
	const store = nonEmpty(record.store);
	const config = nonEmpty(record.config);
	const auth = nonEmpty(record.auth);
	const catalogs = nonEmpty(record.catalogs);
	if (store === void 0 || config === void 0 || auth === void 0 || catalogs === void 0) return void 0;
	return {
		store,
		config,
		auth,
		catalogs
	};
}
/**
* Defensive parse of the adapter's providers answer.
*
* `undefined` for anything that is not a usable view — but an empty `providers`
* array WITH a usable protocol list is valid (a fresh install), and so is a
* provider whose `models` array is empty.
*/
function parseProvidersView(raw) {
	if (typeof raw !== "object" || raw === null) return void 0;
	const record = raw;
	if (!Array.isArray(record.providers)) return void 0;
	if (!Array.isArray(record.protocols)) return void 0;
	const protocols = record.protocols.map(protocolOption).filter((entry) => entry !== void 0);
	if (protocols.length === 0) return void 0;
	const paths = providerPaths(record.paths);
	if (paths === void 0) return void 0;
	const providers = record.providers.map(providerOption).filter((entry) => entry !== void 0);
	const syncedAt = record.syncedAt;
	const note = nonEmpty(record.note);
	return {
		providers,
		native: nativeConfig(record.native),
		protocols,
		paths,
		...typeof syncedAt === "number" && Number.isFinite(syncedAt) ? { syncedAt } : {},
		...note === void 0 ? {} : { note }
	};
}
/**
* The user's own config.toml as the adapter last read it. `null` when the
* adapter said nothing; otherwise an object carrying whichever halves were
* named (an empty one is still news — the panel says the file names nothing).
*/
function nativeConfig(raw) {
	if (typeof raw !== "object" || raw === null) return null;
	const record = raw;
	const providerId = nonEmpty(record.providerId);
	const model = nonEmpty(record.model);
	return {
		...providerId === void 0 ? {} : { providerId },
		...model === void 0 ? {} : { model }
	};
}

//#endregion
//#region src/client/runtime-settings-api.ts
/** One rpcId for request/response correlation. `randomUUID` needs a secure context. */
function mintRpcId() {
	const webCrypto = globalThis.crypto;
	if (webCrypto !== void 0 && typeof webCrypto.randomUUID === "function") return webCrypto.randomUUID();
	if (webCrypto !== void 0 && typeof webCrypto.getRandomValues === "function") return [...webCrypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, "0")).join("");
	return `rpc-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
function settingsEnvelope(namespace, op, args) {
	return {
		type: "client-request",
		rpcId: mintRpcId(),
		method: `${namespace}/${op}`,
		payload: { args }
	};
}
/** What a caller can do with a failed panel call — kept structural for the tests. */
function messageOf(error) {
	if (error !== null && typeof error === "object" && typeof error.message === "string") return error.message;
	return String(error);
}
/**
* One unary call at a runtime's world, unwrapped to the RPC's value.
*
* Every failure mode is reported as a thrown `Error` carrying the adapter's own
* message where one exists: a transport failure, a malformed answer, and the
* gateway's business error (`{ok:false,error}`) must not look alike to the panel.
*
* @param agentKey - roster key addressing the world (`?agent=`).
* @param namespace - the adapter's Remote namespace (`agyAuth`).
* @param op - the Remote method.
* @param args - exact named wire arguments.
* @param doFetch - fetch implementation (tests inject).
* @returns the raw RPC value.
* @throws {Error} on transport, framing, or gateway failure.
*/
async function callRuntimeSettings(agentKey, namespace, op, args, doFetch) {
	const send = doFetch ?? ((input, init) => fetch(input, init));
	const envelope = settingsEnvelope(namespace, op, args);
	const response = await send(`/hub/api?agent=${encodeURIComponent(agentKey)}`, {
		method: "POST",
		credentials: "same-origin",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(envelope)
	});
	const text = await response.text();
	let body;
	try {
		body = JSON.parse(text);
	} catch {
		throw new Error(`settings ${envelope.method}: unreadable answer (HTTP ${response.status})`);
	}
	const result = body?.result;
	if (result === null || typeof result !== "object") throw new Error(`settings ${envelope.method}: malformed answer (HTTP ${response.status})`);
	const record = result;
	if (record.ok === true) return record.value;
	const error = record.error;
	if (error !== void 0 && typeof error.message === "string") throw new Error(error.message);
	throw new Error(`settings ${envelope.method}: failed (HTTP ${response.status})`);
}
/** Read one runtime's panel state, parsed. */
async function fetchAuthView(agentKey, namespace, doFetch) {
	const view = parseAuthView(await callRuntimeSettings(agentKey, namespace, "get", {}, doFetch));
	if (view === void 0) throw new Error("settings: the runtime returned no usable auth options");
	return view;
}
/** Adopt one auth form (`null` clears the explicit choice). */
async function setAuthMode(agentKey, namespace, mode, doFetch) {
	const view = parseAuthView(await callRuntimeSettings(agentKey, namespace, "set", { request: { mode } }, doFetch));
	if (view === void 0) throw new Error("settings: the runtime returned no usable auth options");
	return view;
}
function requireProvidersView(value) {
	const view = parseProvidersView(value);
	if (view === void 0) throw new Error("settings: the runtime returned no usable provider list");
	return view;
}
/** Read the multi-provider state of one runtime. */
async function fetchProvidersView(agentKey, namespace, doFetch) {
	return requireProvidersView(await callRuntimeSettings(agentKey, namespace, "get", {}, doFetch));
}
/**
* Add or edit one provider in the adapter's list. Which provider a session runs
* on is DSH's own per-session model selection, so this touches no active half.
*/
async function saveProvider(agentKey, namespace, provider, doFetch) {
	return requireProvidersView(await callRuntimeSettings(agentKey, namespace, "save", { request: { provider } }, doFetch));
}
/** Drop one provider from the list. Does not rewrite the runtime's own config. */
async function removeProvider(agentKey, namespace, id, doFetch) {
	return requireProvidersView(await callRuntimeSettings(agentKey, namespace, "remove", { request: { id } }, doFetch));
}

//#endregion
//#region src/client/HubPage.tsx
const EMPTY_DRAFT = {
	name: "",
	tokenUrl: ""
};
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
const chipWarn = {
	...chip,
	color: "var(--dsw-alias-state-warn-primary)"
};
const chipError = {
	...chip,
	color: "var(--dsw-alias-state-error-primary)"
};
/** Machine id chip (the m4): the monospace chip look the roster's path tags use. */
const chipMonoId = {
	...chip,
	fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
	fontSize: 10.5
};
/** The status dot's fixed part (the color is decided per row). */
const dotStyle = {
	width: 8,
	height: 8,
	borderRadius: "50%",
	flex: "none"
};
/** The machine origin column: monospace, eats the leftover row width. */
const originStyle = {
	flex: 1,
	minWidth: 0,
	overflow: "hidden",
	textOverflow: "ellipsis",
	whiteSpace: "nowrap",
	fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
	fontSize: 12,
	color: "var(--dsw-alias-label-secondary)"
};
/**
* The row's switch control (P3: the `switch` word is a real BUTTON now — the
* row body toggles the settings panel instead, so the switch needs its own
* hit target that stops propagation).
*/
const switchButtonStyle = {
	border: "none",
	background: "transparent",
	padding: 0,
	font: "inherit",
	fontSize: 12.5,
	color: "var(--dsw-alias-label-secondary)",
	whiteSpace: "nowrap"
};
/** The inline settings panel a row body expands into (P3 accordion). */
const panelStyle = {
	listStyle: "none",
	margin: "0 -8px 4px",
	padding: "10px 12px 12px 42px",
	borderRadius: 12,
	background: "var(--dsw-alias-interactive-bg-hover)",
	fontSize: 12.5
};
/** The icon action (remove ✕) seat. */
const iconActionStyle = {
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
};
/** The quiet text action (reprobe) — the switch/row-action look. */
const textActionStyle = {
	border: "none",
	background: "transparent",
	padding: 0,
	font: "inherit",
	fontSize: 12.5,
	color: "var(--dsw-alias-label-secondary)",
	cursor: "pointer",
	whiteSpace: "nowrap"
};
/** The row's settings panel heading. */
const panelHeadStyle = {
	margin: "0 0 6px",
	fontSize: 12,
	fontWeight: 500,
	color: "var(--dsw-alias-label-secondary)"
};
/** One auth-method option's row in the panel. */
const optionStyle = {
	display: "flex",
	alignItems: "baseline",
	gap: 8,
	width: "100%",
	textAlign: "left",
	border: "none",
	background: "transparent",
	padding: "5px 6px",
	borderRadius: 8,
	font: "inherit",
	fontSize: 12.5,
	color: "var(--dsw-alias-label-primary)"
};
/** The status dot's color: reachable green, pending grey, unreachable amber, auth-expired red. */
function statusDotColor(status) {
	if (status === "reachable") return "var(--dsw-alias-state-success-primary)";
	if (status === "auth-expired") return "var(--dsw-alias-state-error-primary)";
	if (status === "unreachable") return "var(--dsw-alias-state-warn-primary)";
	return "var(--dsw-alias-label-caption)";
}
/** The last-fetch caption's style (R7): quiet tertiary text beside the status chip. */
const ageStyle = {
	fontSize: 11.5,
	color: "var(--dsw-alias-label-tertiary)",
	whiteSpace: "nowrap"
};
/** The status chip (style + text) for one remote row. */
function statusChip(machine) {
	if (machine.status === "reachable") return {
		style: chipSelf,
		text: "reachable"
	};
	if (machine.status === "auth-expired") return {
		style: chipError,
		text: "auth expired"
	};
	if (machine.status === "unreachable") return {
		style: chipWarn,
		text: "unreachable"
	};
	return {
		style: chipPending,
		text: "pending"
	};
}
/** One line of error text for the panel's inline error line. */
function errText(err) {
	return err instanceof Error ? err.message : String(err);
}
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
/** The machine section head inside the roster list (the grouped shape's caption row). */
const sectionHeadStyle = {
	padding: "8px 8px 2px",
	fontSize: 11,
	lineHeight: "16px",
	color: "var(--dsw-alias-label-caption)",
	whiteSpace: "nowrap",
	listStyle: "none"
};
/**
* A row that lights its surface on hover (inline styles have no :hover).
*
* P3: the row BODY is the settings-panel toggle, not the switch — `expanded`
* keeps the surface lit while its panel is open, so the open row stays
* identifiable after the pointer leaves. The switch lives in the row's button.
*/
function HoverRow({ children, onClick, clickable, expanded }) {
	const [hover, setHover] = react.useState(false);
	return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("li", {
		onClick,
		"aria-expanded": expanded,
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
			background: hover || expanded ? "var(--dsw-alias-interactive-bg-hover)" : "transparent",
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
/**
* One runtime's settings, rendered inside its expanded row (P3/P4).
*
* The adapter owns the config, so this component owns no config knowledge: each
* body asks the adapter's Remote and renders what comes back. The round trip
* after a change is authoritative — the adapter re-reads the machine and
* answers with the new state, which is why nothing is optimistically patched
* here (a selection can fall through a ladder, or a switch can leave a provider
* the runtime is still running).
*
* Mounted only while its row is open, so expanding always re-reads the
* machine rather than replaying a stale first read.
*/
function RuntimeSettingsPanel({ agent }) {
	const panel = settingsPanelFor(agent.key);
	if (panel === void 0) return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
		style: {
			margin: 0,
			color: "var(--dsw-alias-label-tertiary)"
		},
		children: "No settings for this runtime yet."
	});
	return panel.kind === "providers" ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(ProvidersPanel, {
		agent,
		namespace: panel.namespace
	}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)(AuthSettingsPanel, {
		agent,
		namespace: panel.namespace
	});
}
/**
* The sign-in-form body (Antigravity): one form picked from the adapter's
* ladder. `namespace` always resolves — the row would not mount this body
* otherwise.
*/
function AuthSettingsPanel({ agent, namespace }) {
	const [view, setView] = react.useState(void 0);
	const [error, setError] = react.useState(null);
	const [busy, setBusy] = react.useState(null);
	const [loading, setLoading] = react.useState(true);
	react.useEffect(() => {
		let live = true;
		setLoading(true);
		fetchAuthView(agent.key, namespace).then((next) => {
			if (live) {
				setView(next);
				setError(null);
			}
		}).catch((err) => {
			if (live) {
				setView(void 0);
				setError(messageOf(err));
			}
		}).finally(() => {
			if (live) setLoading(false);
		});
		return () => {
			live = false;
		};
	}, [agent.key, namespace]);
	const choose = (mode) => {
		if (busy !== null) return;
		setBusy(mode);
		setAuthMode(agent.key, namespace, mode).then((next) => {
			setView(next);
			setError(null);
		}).catch((err) => {
			setError(messageOf(err));
		}).finally(() => {
			setBusy(null);
		});
	};
	if (loading) return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
		style: {
			margin: 0,
			color: "var(--dsw-alias-label-tertiary)"
		},
		children: "Loading settings…"
	});
	if (view === void 0) return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
		style: {
			margin: 0,
			color: "var(--dsw-alias-state-warn-label, var(--dsw-alias-label-secondary))"
		},
		children: error ?? "Settings are unavailable for this runtime."
	});
	const current$1 = activeMethod(view);
	return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
		style: {
			display: "flex",
			flexDirection: "column",
			gap: 4
		},
		children: [
			/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
				style: panelHeadStyle,
				children: "Sign-in method"
			}),
			view.methods.map((option) => {
				const isCurrent = current$1?.key === option.key;
				const disabled = !selectable(option) || busy !== null;
				return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
					type: "button",
					role: "radio",
					"aria-checked": isCurrent,
					disabled,
					onClick: () => {
						choose(option.key);
					},
					style: {
						...optionStyle,
						color: disabled ? "var(--dsw-alias-label-tertiary)" : "var(--dsw-alias-label-primary)",
						cursor: disabled ? "default" : "pointer",
						background: isCurrent ? "var(--dsw-alias-bg-elevated, transparent)" : "transparent"
					},
					children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							"aria-hidden": true,
							style: {
								width: 12,
								flex: "0 0 12px"
							},
							children: isCurrent ? "●" : "○"
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							style: {
								fontWeight: 500,
								whiteSpace: "nowrap"
							},
							children: option.label
						}),
						isCurrent && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							style: chipSelf,
							children: "in force"
						}),
						!option.available && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							style: chip,
							children: "not detected"
						}),
						option.placeholder && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							style: chip,
							children: "placeholder"
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							style: {
								flex: 1,
								minWidth: 0,
								color: "var(--dsw-alias-label-tertiary)"
							},
							children: option.hint
						}),
						busy === option.key && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							style: chip,
							children: "applying…"
						})
					]
				}, option.key);
			}),
			view.note !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
				style: {
					margin: "2px 0 0",
					color: "var(--dsw-alias-label-tertiary)"
				},
				children: view.note
			}),
			error !== null && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
				style: {
					margin: "2px 0 0",
					color: "var(--dsw-alias-state-error-primary)"
				},
				children: error
			}),
			view.settingsPath !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("p", {
				style: {
					margin: "4px 0 0",
					color: "var(--dsw-alias-label-caption)",
					fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
					fontSize: 11
				},
				children: ["writes ", view.settingsPath]
			})
		]
	});
}
/** Field and control styling for the providers body — same visual language as the auth list. */
const fieldStyle = {
	display: "flex",
	flexDirection: "column",
	gap: 3,
	fontSize: 12.5,
	color: "var(--dsw-alias-label-secondary)"
};
const buttonStyle = {
	font: "inherit",
	fontSize: 12.5,
	padding: "5px 10px",
	borderRadius: 6,
	border: "1px solid var(--dsw-alias-border-secondary, rgba(127,127,127,0.3))",
	background: "transparent",
	color: "var(--dsw-alias-label-primary)",
	cursor: "pointer"
};
const primaryButtonStyle = {
	...buttonStyle,
	border: "none",
	background: "var(--dsw-alias-label-primary)",
	color: "var(--dsw-alias-bg-base, #fff)",
	fontWeight: 500
};
/** The blank draft the Add form starts from. */
const EMPTY_PROVIDER_DRAFT = {
	id: "",
	label: "",
	baseUrl: "",
	protocol: "responses",
	apiKey: "",
	envName: "",
	modelIds: "",
	contextWindow: ""
};
/** `a, b c` → `['a','b','c']` — the model field takes whatever separator is natural. */
function parseModelIds(text) {
	return text.split(/[\s,]+/).map((part) => part.trim()).filter((part) => part !== "");
}
/** `provider / model`, whichever halves the user's config.toml actually names. */
function nativeDescription(native) {
	const parts = [native.providerId, native.model].filter((part) => part !== void 0);
	return parts.length === 0 ? "no provider" : parts.join(" / ");
}
/**
* The multi-provider body (Codex, 2026-10-03 ruling).
*
* Super D hosts the list cc-switch otherwise holds: add, edit and remove only.
* The active/select half is gone — which provider a Codex session runs on is
* DSH's own per-session model selection, so no row is marked "in force". What
* the user's OWN config.toml names is rendered as a passive fact (the adapter
* reconciles the list against that file), and the files it touches are named so
* an edit is never a surprise.
*
* Keys are write-only by construction: the adapter answers `hasKey`, never a
* value, so the field is blank on every open and blank means "leave whatever is
* already there".
*/
function ProvidersPanel({ agent, namespace }) {
	const [view, setView] = react.useState(void 0);
	const [error, setError] = react.useState(null);
	const [busy, setBusy] = react.useState(null);
	const [loading, setLoading] = react.useState(true);
	/** The id being edited, `NEW_PROVIDER` for the add form, `null` when closed. */
	const [editing, setEditing] = react.useState(null);
	const [draft, setDraft] = react.useState(EMPTY_PROVIDER_DRAFT);
	react.useEffect(() => {
		let live = true;
		setLoading(true);
		fetchProvidersView(agent.key, namespace).then((next) => {
			if (live) {
				setView(next);
				setError(null);
			}
		}).catch((err) => {
			if (live) {
				setView(void 0);
				setError(messageOf(err));
			}
		}).finally(() => {
			if (live) setLoading(false);
		});
		return () => {
			live = false;
		};
	}, [agent.key, namespace]);
	/** One mutation, one authoritative re-read; `key` drives the busy chip. */
	const run = (key, call) => {
		if (busy !== null) return;
		setBusy(key);
		call().then((next) => {
			setView(next);
			setError(null);
			setEditing(null);
			setDraft(EMPTY_PROVIDER_DRAFT);
		}).catch((err) => {
			setError(messageOf(err));
		}).finally(() => {
			setBusy(null);
		});
	};
	const openNew = () => {
		setEditing(NEW_PROVIDER);
		setDraft(EMPTY_PROVIDER_DRAFT);
		setError(null);
	};
	const openEdit = (provider) => {
		setEditing(provider.id);
		setDraft({
			id: provider.id,
			label: provider.label,
			baseUrl: provider.baseUrl,
			protocol: provider.protocol,
			apiKey: "",
			envName: provider.envName ?? "",
			modelIds: provider.models.map((model) => model.id).join(", "),
			contextWindow: provider.models[0]?.contextWindow === void 0 ? "" : String(provider.models[0].contextWindow)
		});
		setError(null);
	};
	const submit = () => {
		const ids = parseModelIds(draft.modelIds);
		const window$1 = draft.contextWindow.trim() === "" ? void 0 : Number(draft.contextWindow);
		const provider = {
			id: draft.id.trim(),
			label: draft.label.trim(),
			baseUrl: draft.baseUrl.trim(),
			protocol: draft.protocol,
			auth: draft.envName.trim() === "" ? {
				kind: "apiKey",
				value: draft.apiKey
			} : {
				kind: "env",
				name: draft.envName.trim()
			},
			models: ids.map((id) => ({
				id,
				...window$1 !== void 0 && Number.isSafeInteger(window$1) && window$1 > 0 ? { contextWindow: window$1 } : {}
			}))
		};
		run("save", () => saveProvider(agent.key, namespace, provider));
	};
	if (loading) return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
		style: {
			margin: 0,
			color: "var(--dsw-alias-label-tertiary)"
		},
		children: "Loading providers…"
	});
	if (view === void 0) return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
		style: {
			margin: 0,
			color: "var(--dsw-alias-state-warn-label, var(--dsw-alias-label-secondary))"
		},
		children: error ?? "Providers are unavailable for this runtime."
	});
	return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
		style: {
			display: "flex",
			flexDirection: "column",
			gap: 6
		},
		children: [
			/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
				style: panelHeadStyle,
				children: "Model provider"
			}),
			view.native !== null && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("p", {
				style: {
					margin: 0,
					color: "var(--dsw-alias-label-tertiary)"
				},
				children: [
					"Your own Codex config.toml currently names ",
					nativeDescription(view.native),
					"."
				]
			}),
			view.syncedAt !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("p", {
				style: {
					margin: 0,
					color: "var(--dsw-alias-label-caption)",
					fontSize: 11
				},
				children: ["synced from config.toml ", new Date(view.syncedAt).toLocaleString()]
			}),
			view.providers.length === 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
				style: {
					margin: 0,
					color: "var(--dsw-alias-label-tertiary)"
				},
				children: "No providers yet — add one to pin a model and endpoint."
			}),
			view.providers.map((provider) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				style: optionStyle,
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						style: {
							fontWeight: 500,
							whiteSpace: "nowrap"
						},
						children: provider.label
					}),
					provider.authKind === "env" && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
						style: chip,
						children: ["env ", provider.envName]
					}),
					!provider.hasKey && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						style: chip,
						children: "no key"
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
						style: {
							flex: 1,
							minWidth: 0,
							overflow: "hidden",
							textOverflow: "ellipsis",
							whiteSpace: "nowrap",
							fontSize: 12,
							color: "var(--dsw-alias-label-tertiary)"
						},
						children: [provider.baseUrl, provider.models.length === 0 ? "" : ` · ${provider.models.map((model) => model.id).join(", ")}`]
					}),
					provider.models.length === 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						style: chipWarn,
						children: "no models yet — add one"
					}),
					busy === `remove:${provider.id}` && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						style: chip,
						children: "removing…"
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
						type: "button",
						style: buttonStyle,
						disabled: busy !== null,
						onClick: () => {
							openEdit(provider);
						},
						children: "Edit"
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
						type: "button",
						style: {
							...buttonStyle,
							color: "var(--dsw-alias-state-error-primary, #c66)"
						},
						disabled: busy !== null,
						"aria-label": `Delete ${provider.label}`,
						onClick: () => {
							run(`remove:${provider.id}`, () => removeProvider(agent.key, namespace, provider.id));
						},
						children: "Delete"
					})
				]
			}, provider.id)),
			editing === null && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", { children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
				type: "button",
				style: buttonStyle,
				disabled: busy !== null,
				onClick: openNew,
				children: "+ Add provider"
			}) }),
			editing !== null && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				style: {
					display: "flex",
					flexDirection: "column",
					gap: 8,
					maxWidth: 520
				},
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						style: panelHeadStyle,
						children: editing === NEW_PROVIDER ? "Add provider" : `Edit ${editing}`
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
						style: fieldStyle,
						children: ["Provider id", /* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
							style: inputStyle,
							value: draft.id,
							disabled: editing !== NEW_PROVIDER,
							placeholder: "zai-plan",
							onChange: (event) => {
								setDraft({
									...draft,
									id: event.target.value
								});
							}
						})]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
						style: fieldStyle,
						children: ["Display name", /* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
							style: inputStyle,
							value: draft.label,
							placeholder: "Z.ai Plan",
							onChange: (event) => {
								setDraft({
									...draft,
									label: event.target.value
								});
							}
						})]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
						style: fieldStyle,
						children: ["Base URL", /* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
							style: inputStyle,
							value: draft.baseUrl,
							placeholder: "https://api.z.ai/api/coding/paas/v4",
							onChange: (event) => {
								setDraft({
									...draft,
									baseUrl: event.target.value
								});
							}
						})]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
						style: fieldStyle,
						children: ["API protocol", /* @__PURE__ */ (0, react_jsx_runtime.jsx)("select", {
							style: inputStyle,
							value: draft.protocol,
							onChange: (event) => {
								setDraft({
									...draft,
									protocol: event.target.value
								});
							},
							children: view.protocols.map((option) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("option", {
								value: option.value,
								disabled: !option.available,
								title: option.hint,
								children: [option.label, option.available ? "" : " — unsupported"]
							}, option.value))
						})]
					}),
					(() => {
						const option = view.protocols.find((candidate) => candidate.value === draft.protocol);
						return option === void 0 || option.available ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
							style: {
								margin: 0,
								color: "var(--dsw-alias-state-error-primary, #c66)",
								fontSize: 12
							},
							children: option.hint
						});
					})(),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
						style: fieldStyle,
						children: ["Model IDs", /* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
							style: inputStyle,
							value: draft.modelIds,
							placeholder: "glm-5.2, glm-5.2-air",
							onChange: (event) => {
								setDraft({
									...draft,
									modelIds: event.target.value
								});
							}
						})]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
						style: fieldStyle,
						children: ["Context window (tokens, optional)", /* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
							style: inputStyle,
							value: draft.contextWindow,
							inputMode: "numeric",
							placeholder: "1000000",
							onChange: (event) => {
								setDraft({
									...draft,
									contextWindow: event.target.value
								});
							}
						})]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
						style: fieldStyle,
						children: [
							"API key ",
							editing !== NEW_PROVIDER && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								style: { color: "var(--dsw-alias-label-caption)" },
								children: "(leave blank to keep the saved one)"
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
								style: inputStyle,
								type: "password",
								value: draft.apiKey,
								autoComplete: "off",
								onChange: (event) => {
									setDraft({
										...draft,
										apiKey: event.target.value
									});
								}
							})
						]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
						style: fieldStyle,
						children: ["…or read the key from an environment variable", /* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
							style: inputStyle,
							value: draft.envName,
							placeholder: "DEEPSEEK_API_KEY",
							onChange: (event) => {
								setDraft({
									...draft,
									envName: event.target.value
								});
							}
						})]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						style: {
							display: "flex",
							gap: 6
						},
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
							type: "button",
							style: primaryButtonStyle,
							disabled: busy !== null,
							onClick: submit,
							children: busy === "save" ? "Saving…" : "Save"
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
							type: "button",
							style: buttonStyle,
							disabled: busy !== null,
							onClick: () => {
								setEditing(null);
								setDraft(EMPTY_PROVIDER_DRAFT);
							},
							children: "Cancel"
						})]
					})
				]
			}),
			view.note !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
				style: {
					margin: "2px 0 0",
					color: "var(--dsw-alias-label-tertiary)"
				},
				children: view.note
			}),
			error !== null && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
				style: {
					margin: "2px 0 0",
					color: "var(--dsw-alias-state-error-primary)"
				},
				children: error
			}),
			/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("p", {
				style: {
					margin: "4px 0 0",
					color: "var(--dsw-alias-label-caption)",
					fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
					fontSize: 11
				},
				children: ["list ", view.paths.store]
			}),
			/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("p", {
				style: {
					margin: 0,
					color: "var(--dsw-alias-label-caption)",
					fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
					fontSize: 11
				},
				children: [
					"native ",
					view.paths.config,
					" · ",
					view.paths.auth,
					" · ",
					view.paths.catalogs
				]
			})
		]
	});
}
/** Sentinel for "the add form", distinct from any real provider id. */
const NEW_PROVIDER = "\0new";
function HubPage() {
	const [mesh, setMesh] = react.useState({ machines: [] });
	const [meshLoaded, setMeshLoaded] = react.useState(false);
	const [meshError, setMeshError] = react.useState(null);
	const [meshBusy, setMeshBusy] = react.useState(false);
	const [meshReloads, setMeshReloads] = react.useState(0);
	const [showAdd, setShowAdd] = react.useState(false);
	const [draft, setDraft] = react.useState(EMPTY_DRAFT);
	const [agents, setAgents] = react.useState(() => rosterFromGlobal() ?? null);
	const [rosterFailed, setRosterFailed] = react.useState(false);
	const [tab, setTab] = react.useState("home");
	const fusion = fusionPage();
	const switchUi = switchAffordance(fusion);
	const [activeKey, setActiveKey] = react.useState(() => fusion ? uiState()?.activeAgent : void 0);
	/**
	* The open settings panel (P3 accordion): one runtime key at a time, or
	* `null` when every row is collapsed. `toggleExpanded` owns the transition.
	*/
	const [expandedKey, setExpandedKey] = react.useState(null);
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
		let cancelled = false;
		fetchMachines().then((list) => {
			if (!cancelled) {
				setMesh(list);
				setMeshError(null);
				setMeshLoaded(true);
			}
		}).catch((err) => {
			if (!cancelled) {
				setMeshError(errText(err));
				setMeshLoaded(true);
			}
		});
		return () => {
			cancelled = true;
		};
	}, [meshReloads]);
	react.useEffect(() => {
		if (!fusion) return;
		const state = uiState();
		if (state === void 0) return;
		return state.subscribe((label) => {
			setActiveKey(label);
		});
	}, [fusion]);
	const here = currentMountPath();
	const hereOrigin = typeof location === "undefined" ? "" : location.origin;
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
	* the page exactly where it is. Non-fusion pages have no navigation arm to
	* fall back to (T-C retired the URL family), so the pass-through decision
	* is simply inert.
	*/
	const rowDecision = (agent, event) => {
		if (seatClickDecision({
			fusion,
			active: isActive(agent),
			attempt: () => attemptSwitch(agent.key)
		}).preventDefault) event.preventDefault();
	};
	const machineLabels = meshLoaded && meshError === null ? machineLabelsFrom(mesh) : void 0;
	const groups = agents !== null && machineLabels !== void 0 ? groupByMachine(agents, machineLabels) : void 0;
	/**
	* One Agent Runtimes row — the SAME row in both shapes; `showMachine`
	* keeps the flat fallback's per-row machine text (the grouped shape moves
	* it onto the section head).
	*
	* P3 interaction (2026-10-02 user ruling): the ROW BODY expands this
	* runtime's OWN settings inline (accordion — one panel at a time), and the
	* right-hand `switch` is the row's ONLY switch, now a real button. The two
	* are separate controls on purpose: expanding is navigation of config, the
	* button performs `seatClickDecision` (intercept + in-place switchAgent).
	*/
	const renderRow = (agent, showMachine) => {
		const expanded = expandedKey === agent.key;
		return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react.Fragment, { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)(HoverRow, {
			clickable: true,
			expanded,
			onClick: () => {
				setExpandedKey((current$1) => toggleExpanded(current$1, agent.key));
			},
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
					children: showMachine ? agent.machine : null
				}),
				isActive(agent) && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
					style: chipSelf,
					children: "current"
				}),
				switchUi.available && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
					type: "button",
					"aria-current": isActive(agent) ? "page" : void 0,
					"aria-label": isActive(agent) ? `${agent.label} is current` : `Switch to ${agent.label}`,
					style: {
						...switchButtonStyle,
						color: isActive(agent) ? "var(--dsw-alias-label-tertiary)" : "var(--dsw-alias-label-secondary)",
						cursor: "pointer"
					},
					onClick: (event) => {
						event.stopPropagation();
						rowDecision(agent, event);
					},
					children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(__deepseek_ai_dsh_client_ui_primitives.IconPlayOutlineRegular, { size: 16 })
				})
			]
		}), expanded && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("li", {
			style: panelStyle,
			children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(RuntimeSettingsPanel, { agent })
		})] }, agent.key);
	};
	/** Bump the reload sequence — every mutating op refreshes through the API. */
	const reloadMachines = () => {
		setMeshReloads((n) => n + 1);
	};
	const addRemote = () => {
		const name = draft.name.trim();
		const tokenUrl = draft.tokenUrl.trim();
		if (name === "" || !validTokenUrl(tokenUrl)) return;
		setMeshBusy(true);
		addMachine({
			name,
			tokenUrl
		}).then(() => {
			setDraft(EMPTY_DRAFT);
			setShowAdd(false);
			setMeshError(null);
			reloadMachines();
		}).catch((err) => {
			setMeshError(errText(err));
		}).finally(() => {
			setMeshBusy(false);
		});
	};
	const removeRemote = (id) => {
		removeMachine(id).then(() => {
			setMeshError(null);
			reloadMachines();
		}).catch((err) => {
			setMeshError(errText(err));
		});
	};
	const reprobeRemote = (id) => {
		reprobeMachine(id).then(() => {
			setMeshError(null);
			reloadMachines();
		}).catch((err) => {
			setMeshError(errText(err));
		});
	};
	const draftValid = draft.name.trim() !== "" && validTokenUrl(draft.tokenUrl.trim());
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
							count: (mesh.self !== void 0 ? 1 : 0) + mesh.machines.length,
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
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("p", {
							style: {
								margin: 0,
								fontSize: 13,
								lineHeight: "20px",
								color: "var(--dsw-alias-label-tertiary)"
							},
							children: [
								"Add another DSH from remote machines, provide the token URL. Status ",
								AUTO_REFRESH_NOTE,
								"."
							]
						}),
						meshError !== null && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
							style: {
								margin: 0,
								fontSize: 12.5,
								lineHeight: "20px",
								color: "var(--dsw-alias-state-error-primary)"
							},
							children: meshError
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("ul", {
							style: listStyle,
							children: [
								!meshLoaded && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("li", {
									style: {
										padding: "9px 8px",
										fontSize: 13,
										color: "var(--dsw-alias-label-tertiary)",
										listStyle: "none"
									},
									children: "Loading machines…"
								}),
								meshLoaded && meshError === null && mesh.machines.length === 0 && mesh.self === void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("li", {
									style: {
										padding: "9px 8px",
										fontSize: 13,
										color: "var(--dsw-alias-label-tertiary)",
										listStyle: "none"
									},
									children: "No machines yet — add the first one with its token URL."
								}),
								mesh.self !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(HoverRow, { children: [
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										"aria-hidden": true,
										style: {
											...dotStyle,
											background: "var(--dsw-alias-state-success-primary)"
										}
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										style: {
											fontWeight: 500,
											whiteSpace: "nowrap"
										},
										children: mesh.self.label
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										style: originStyle,
										children: hereOrigin
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										style: chipMonoId,
										children: mesh.self.id
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										style: chipSelf,
										children: "self"
									})
								] }),
								mesh.machines.map((machine) => {
									const status = statusChip(machine);
									return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(HoverRow, { children: [
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
											"aria-hidden": true,
											style: {
												...dotStyle,
												background: statusDotColor(machine.status)
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
											style: originStyle,
											children: machine.origin
										}),
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
											style: chipMonoId,
											children: machine.id
										}),
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
											style: status.style,
											children: status.text
										}),
										lastFetchLabel(machine.lastProbeAt, Date.now()) !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
											style: ageStyle,
											children: lastFetchLabel(machine.lastProbeAt, Date.now())
										}),
										machineVersionChip(machine) !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
											style: chipWarn,
											title: `machine ${machine.id}`,
											children: machine.versionWarning
										}),
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
											type: "button",
											"aria-label": `Refresh ${machine.name}`,
											onClick: () => {
												reprobeRemote(machine.id);
											},
											style: textActionStyle,
											children: "refresh"
										}),
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
											type: "button",
											"aria-label": `Remove ${machine.name}`,
											onClick: () => {
												removeRemote(machine.id);
											},
											style: iconActionStyle,
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
									] }, machine.id);
								})
							]
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
									children: "Token URL"
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
									style: inputStyle,
									value: draft.tokenUrl,
									placeholder: "https://192.0.2.130:4999/?token=…",
									onChange: (event) => {
										setDraft({
											...draft,
											tokenUrl: event.target.value
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
										disabled: !draftValid || meshBusy,
										onClick: () => {
											addRemote();
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
						!switchUi.available && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							style: { display: "flex" },
							children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								style: {
									...chip,
									color: "var(--dsw-alias-label-caption)"
								},
								children: switchUi.hint
							})
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
							children: [
								agents === null && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("li", {
									style: {
										padding: "9px 8px",
										fontSize: 13,
										color: "var(--dsw-alias-label-tertiary)",
										listStyle: "none"
									},
									children: "Loading roster…"
								}),
								groups !== void 0 && groups.map((group) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react.Fragment, { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("li", {
									"aria-hidden": true,
									style: sectionHeadStyle,
									children: group.label
								}), group.agents.map((agent) => renderRow(agent, false))] }, group.key)),
								groups === void 0 && agents?.map((agent) => renderRow(agent, true))
							]
						})
					]
				})] })
			]
		})
	});
}

//#endregion
//#region src/client/toast.ts
/**
* The element for one pending toast: keyed by sequence so a newer toast
* remounts the primitive and restarts its slide-in cycle (the primitive's
* own re-show contract).
*/
function superdToastElement(toast) {
	return react.createElement(__deepseek_ai_dsh_client_ui_primitives.Toast, {
		key: toast.seq,
		...toastProps(toast.text, toast.options),
		onDone: () => {
			clearSuperdToast(toast.seq);
		}
	});
}
/**
* The always-mounted owner: subscribes to the store and renders the current
* toast (nothing while the store is empty). Mounted inside the Hub sidebar
* row — the primitive's body portal places the banner top-center regardless
* of where the owner sits.
*/
function SuperdToastHost() {
	const [toast, setToast] = react.useState(void 0);
	react.useEffect(() => onSuperdToast(setToast), []);
	return toast === void 0 ? null : superdToastElement(toast);
}

//#endregion
//#region src/client/HubPanelIcon.tsx
/** Runtime-mark edge inside the selector, and the chevron's own default edge. */
const MARK_SIZE = 16;
const CHEVRON_SIZE = 14;
/**
* Selector pill metrics (AgentPresetSeat's `.seat`): a 28px control with 8px
* side padding and a 4px icon gap. Width is the sum, so the pill hugs its two
* marks instead of leaving the mark floating in a fixed box.
*/
const SELECTOR_HEIGHT = 28;
const SELECTOR_PAD = 8;
const SELECTOR_GAP = 4;
/** The row's own horizontal padding (native `.panelRow`): the selector's inset. */
const ROW_INSET = 8;
function HubPanelIcon({ size }) {
	const wide = size <= 16;
	const rootRef = react.useRef(null);
	const selectorRef = react.useRef(null);
	const [open, setOpen] = react.useState(false);
	const [hover, setHover] = react.useState(false);
	const [box, setBox] = react.useState(null);
	const [agents, setAgents] = react.useState(() => rosterFromGlobal() ?? [NATIVE_LINK]);
	const [machineLabels, setMachineLabels] = react.useState(void 0);
	const fusion = fusionPage();
	const switchUi = switchAffordance(fusion);
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
		setBox((prev) => prev !== null && prev.top === rect.top && prev.bottom === rect.bottom && prev.right === rect.right ? prev : {
			top: rect.top,
			bottom: rect.bottom,
			right: rect.right
		});
	}, []);
	react.useLayoutEffect(() => {
		if (!wide || !switchUi.available) return;
		measure();
		const row = rootRef.current?.closest("button") ?? null;
		let observer;
		if (row !== null && typeof ResizeObserver !== "undefined") {
			observer = new ResizeObserver(() => {
				measure();
			});
			observer.observe(row);
		}
		window.addEventListener("resize", measure);
		return () => {
			observer?.disconnect();
			window.removeEventListener("resize", measure);
		};
	}, [
		wide,
		switchUi.available,
		measure
	]);
	react.useEffect(() => {
		if (!open || !switchUi.available) return;
		let cancelled = false;
		fetchRoster().then((list) => {
			if (!cancelled) setAgents(list);
		}).catch(() => {});
		fetchMachines().then((list) => {
			if (!cancelled) setMachineLabels(machineLabelsFrom(list));
		}).catch(() => {});
		return () => {
			cancelled = true;
		};
	}, [open, switchUi.available]);
	react.useEffect(() => {
		if (!wide || !switchUi.available) setOpen(false);
	}, [wide, switchUi.available]);
	const anchorRect = react.useCallback(() => selectorRef.current?.getBoundingClientRect() ?? null, []);
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
	const items = [];
	if (machineLabels !== void 0) groupByMachine(agents, machineLabels).forEach((group, groupIndex) => {
		if (groupIndex > 0) items.push({
			type: "separator",
			id: `machine-divider:${group.key}`
		});
		items.push({
			type: "label",
			id: `machine:${group.key}`,
			text: group.label
		});
		for (const agent of group.agents) items.push({
			id: agent.key,
			label: agent.label,
			icon: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(RuntimeMark, {
				agentKey: agent.key,
				size: 14
			})
		});
	});
	else for (const agent of agents) items.push({
		id: agent.key,
		label: agent.label,
		icon: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(RuntimeMark, {
			agentKey: agent.key,
			size: 14
		})
	});
	/**
	* A menu pick. The row is a `menuitem` button — there is no anchor default
	* to cancel — but the shared table still owns whether the attempt runs
	* (the active entry is a no-op, the fusion arm never navigates).
	*/
	const select = (id) => {
		setOpen(false);
		const agent = agents.find((row) => row.key === id);
		if (agent === void 0) return;
		seatClickDecision({
			fusion,
			active: isActive(agent),
			attempt: () => attemptSwitch(agent.key)
		});
	};
	const activeLabel = activeAgentName(activeKey, agents);
	const selectorWidth = SELECTOR_PAD * 2 + CHEVRON_SIZE + (activeKey === void 0 ? 0 : MARK_SIZE + SELECTOR_GAP);
	return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
		ref: rootRef,
		style: {
			display: "inline-flex",
			alignItems: "center",
			justifyContent: "center"
		},
		children: [
			/* @__PURE__ */ (0, react_jsx_runtime.jsx)(HubGlyph, { size }),
			/* @__PURE__ */ (0, react_jsx_runtime.jsx)(SuperdToastHost, {}),
			wide && box !== null && switchUi.available && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(__deepseek_ai_dsh_client_ui_primitives.Menu, {
				open,
				onClose: () => {
					setOpen(false);
				},
				items,
				selectedIds: activeKey === void 0 ? [] : [activeKey],
				onSelect: select,
				dense: true,
				portal: true,
				align: "end",
				getAnchorRect: anchorRect,
				anchor: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
					ref: selectorRef,
					role: "button",
					tabIndex: 0,
					"aria-label": "Agent selector",
					"aria-haspopup": "menu",
					"aria-expanded": open,
					title: activeLabel === void 0 ? "Agent selector" : `Agent selector: ${activeLabel}`,
					style: {
						position: "fixed",
						left: box.right - ROW_INSET - selectorWidth,
						top: box.top + (box.bottom - box.top) / 2,
						transform: "translateY(-50%)",
						display: "inline-flex",
						alignItems: "center",
						justifyContent: "center",
						gap: SELECTOR_GAP,
						boxSizing: "border-box",
						width: selectorWidth,
						height: SELECTOR_HEIGHT,
						padding: `0 ${SELECTOR_PAD}px`,
						borderRadius: 16,
						background: hover || open ? "var(--dsw-alias-interactive-bg-hover)" : "transparent",
						color: "var(--dsw-alias-label-caption)",
						cursor: "pointer",
						zIndex: 50
					},
					onMouseEnter: () => {
						setHover(true);
					},
					onMouseLeave: () => {
						setHover(false);
					},
					onClick: toggle,
					onKeyDown: (event) => {
						if (event.key === "Enter" || event.key === " ") toggle(event);
					},
					children: [activeKey !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(RuntimeMark, {
						agentKey: activeKey,
						size: MARK_SIZE
					}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(__deepseek_ai_dsh_client_ui_primitives.IconChevronDownOutlineRegular, { size: CHEVRON_SIZE })]
				})
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
		"workspaces",
		"sessions"
	], (raw) => {
		bindSwitchAgent(raw);
	});
}

//#endregion
exports.apply = apply;
exports.inject = inject;
return module.exports; } });