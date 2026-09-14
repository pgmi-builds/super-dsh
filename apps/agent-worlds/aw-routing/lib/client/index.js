window.__ModuleLoader__.load({ id: "@pgmi-builds/multi-agent-routing", factory: (require) => {
var module = { exports: {} }; var exports = module.exports;
//#region rolldown:runtime
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __commonJS = (cb, mod) => function() {
	return mod || (0, cb[__getOwnPropNames(cb)[0]])((mod = { exports: {} }).exports, mod), mod.exports;
};
var __copyProps = (to, from, except, desc) => {
	if (from && typeof from === "object" || typeof from === "function") for (var keys = __getOwnPropNames(from), i = 0, n$1 = keys.length, key; i < n$1; i++) {
		key = keys[i];
		if (!__hasOwnProp.call(to, key) && key !== except) __defProp(to, key, {
			get: ((k$1) => from[k$1]).bind(null, key),
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

//#region ../../../node_modules/react/cjs/react-jsx-runtime.production.min.js
var require_react_jsx_runtime_production_min = /* @__PURE__ */ __commonJS({ "../../../node_modules/react/cjs/react-jsx-runtime.production.min.js": ((exports) => {
	var f = require("react"), k = Symbol.for("react.element"), l = Symbol.for("react.fragment"), m = Object.prototype.hasOwnProperty, n = f.__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED.ReactCurrentOwner, p = {
		key: !0,
		ref: !0,
		__self: !0,
		__source: !0
	};
	function q(c, a, g) {
		var b, d = {}, e = null, h = null;
		void 0 !== g && (e = "" + g);
		void 0 !== a.key && (e = "" + a.key);
		void 0 !== a.ref && (h = a.ref);
		for (b in a) m.call(a, b) && !p.hasOwnProperty(b) && (d[b] = a[b]);
		if (c && c.defaultProps) for (b in a = c.defaultProps, a) void 0 === d[b] && (d[b] = a[b]);
		return {
			$$typeof: k,
			type: c,
			key: e,
			ref: h,
			props: d,
			_owner: n.current
		};
	}
	exports.Fragment = l;
	exports.jsx = q;
	exports.jsxs = q;
}) });

//#endregion
//#region ../../../node_modules/react/jsx-runtime.js
var require_jsx_runtime = /* @__PURE__ */ __commonJS({ "../../../node_modules/react/jsx-runtime.js": ((exports, module) => {
	module.exports = require_react_jsx_runtime_production_min();
}) });

//#endregion
//#region src/client/RuntimeSeat.tsx
var import_jsx_runtime = /* @__PURE__ */ __toESM(require_jsx_runtime());
const RUNTIME_LABELS = {
	native: "Native (DSH)",
	omp: "OMP (SDK)"
};
function label(key) {
	return RUNTIME_LABELS[key] ?? key;
}
function RuntimeSeat({ wide }) {
	const [state, setState] = react.useState({
		runtime: "native",
		available: ["native"]
	});
	const [open, setOpen] = react.useState(false);
	const [busy, setBusy] = react.useState(false);
	const [error, setError] = react.useState(void 0);
	const rootRef = react.useRef(null);
	react.useEffect(() => {
		let cancelled = false;
		fetch("/api/agent-runtime", { credentials: "same-origin" }).then((r) => r.ok ? r.json() : Promise.reject(/* @__PURE__ */ new Error(`HTTP ${r.status}`))).then((j) => {
			if (cancelled) return;
			if (typeof j?.runtime === "string") setState({
				runtime: j.runtime,
				available: Array.isArray(j.available) ? j.available.filter((k$1) => typeof k$1 === "string") : ["native"]
			});
		}).catch(() => {});
		return () => {
			cancelled = true;
		};
	}, []);
	react.useEffect(() => {
		if (!open) return;
		const onDown = (event) => {
			if (rootRef.current !== null && !rootRef.current.contains(event.target)) setOpen(false);
		};
		document.addEventListener("mousedown", onDown);
		return () => document.removeEventListener("mousedown", onDown);
	}, [open]);
	const pick = (key) => {
		if (key === state.runtime || busy) return;
		setBusy(true);
		setOpen(false);
		setError(void 0);
		fetch("/api/agent-runtime", {
			method: "POST",
			credentials: "same-origin",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ runtime: key })
		}).then((r) => r.ok ? r.json() : Promise.reject(/* @__PURE__ */ new Error(`HTTP ${r.status}`))).then((j) => {
			if (typeof j?.runtime === "string") {
				setState((prev) => ({
					...prev,
					runtime: j.runtime
				}));
				setTimeout(() => {
					window.location.reload();
				}, 150);
			}
		}).catch((e) => {
			setError(String(e));
		}).finally(() => {
			setBusy(false);
		});
	};
	const styleBase = {
		display: "flex",
		alignItems: "center",
		gap: 8,
		width: "100%",
		padding: wide ? "7px 10px" : "7px 0",
		justifyContent: wide ? "flex-start" : "center",
		border: "none",
		borderRadius: 8,
		background: "transparent",
		color: "inherit",
		font: "inherit",
		fontSize: 13,
		cursor: busy ? "wait" : "pointer",
		opacity: busy ? .6 : 1,
		position: "relative"
	};
	const styleBadge = {
		fontSize: 10,
		lineHeight: 1.4,
		padding: "1px 6px",
		borderRadius: 999,
		background: "color-mix(in srgb, currentColor 12%, transparent)",
		whiteSpace: "nowrap"
	};
	const styleMenu = {
		position: "absolute",
		bottom: "calc(100% + 6px)",
		left: 6,
		right: 6,
		zIndex: 40,
		background: "var(--dsh-surface, #26262b)",
		border: "1px solid color-mix(in srgb, currentColor 18%, transparent)",
		borderRadius: 10,
		boxShadow: "0 8px 24px rgba(0,0,0,.35)",
		overflow: "hidden"
	};
	const styleItem = (active) => ({
		display: "block",
		width: "100%",
		padding: "8px 12px",
		border: "none",
		background: active ? "color-mix(in srgb, currentColor 10%, transparent)" : "transparent",
		color: "inherit",
		font: "inherit",
		fontSize: 13,
		textAlign: "left",
		cursor: "pointer"
	});
	return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
		ref: rootRef,
		style: {
			position: "relative",
			width: "100%"
		},
		children: [
			/* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", {
				type: "button",
				style: styleBase,
				title: "agent runtime — the one app-level selector; switching swaps the whole data plane",
				onClick: () => {
					setOpen((v) => !v);
				},
				children: wide ? /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(import_jsx_runtime.Fragment, { children: [
					/* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", {
						"aria-hidden": true,
						children: "⌘"
					}),
					/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("span", {
						style: {
							flex: 1,
							textAlign: "left",
							whiteSpace: "nowrap",
							overflow: "hidden",
							textOverflow: "ellipsis"
						},
						children: ["Agent · ", state.runtime]
					}),
					/* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", {
						style: styleBadge,
						children: "switch"
					})
				] }) : /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("span", {
					"aria-hidden": true,
					title: `Agent · ${state.runtime}`,
					children: ["⌘", state.runtime.slice(0, 1).toUpperCase()]
				})
			}),
			error !== void 0 && wide ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", {
				style: {
					fontSize: 11,
					padding: "0 10px",
					opacity: .7
				},
				children: error
			}) : null,
			open ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", {
				style: styleMenu,
				role: "menu",
				children: state.available.map((key) => /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("button", {
					type: "button",
					role: "menuitem",
					style: styleItem(key === state.runtime),
					onClick: () => {
						pick(key);
					},
					children: [label(key), key === state.runtime ? " ✓" : ""]
				}, key))
			}) : null
		]
	});
}

//#endregion
//#region src/client/index.ts
/** Required services (cordis fiber inject): the slot registry. */
const inject = ["slots"];
/**
* Mount the selector. Degrades silently when the slot service is absent (a
* composition without the sidebar renders nothing — a footer action is an
* optional occupant by contract).
*
* @param ctx - client root context.
*/
function apply(ctx) {
	ctx.inject(["slots"], (raw) => {
		const scope = raw;
		scope.effect(() => scope.slots.inject("sidebar.footer.action", () => scope.slots.register({
			name: "sidebar.footer.action",
			id: "agent-runtime"
		}, RuntimeSeat)), "multi-agent-routing: runtime footer action");
	});
}

//#endregion
exports.apply = apply;
exports.inject = inject;
return module.exports; } });