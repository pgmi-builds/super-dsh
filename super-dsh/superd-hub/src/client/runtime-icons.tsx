import * as React from 'react'

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
const RUNTIME_ICON_URIS: Readonly<Record<string, string>> = {
  claude: `data:image/svg+xml;base64,PHN2ZyBoZWlnaHQ9IjY0IiB3aWR0aD0iNjQiIHZpZXdCb3g9IjAgMCAyNCAyNCIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj48cGF0aCBkPSJNNC43MDkgMTUuOTU1bDQuNzItMi42NDcuMDgtLjIzLS4wOC0uMTI4SDkuMmwtLjc5LS4wNDgtMi42OTgtLjA3My0yLjMzOS0uMDk3LTIuMjY2LS4xMjItLjU3MS0uMTIxTDAgMTEuNzg0bC4wNTUtLjM1Mi40OC0uMzIxLjY4Ni4wNiAxLjUyLjEwMyAyLjI3OC4xNTggMS42NTIuMDk3IDIuNDQ5LjI1NWguMzg5bC4wNTUtLjE1Ny0uMTM0LS4wOTgtLjEwMy0uMDk3LTIuMzU4LTEuNTk2LTIuNTUyLTEuNjg4LTEuMzM2LS45NzItLjcyNC0uNDkxLS4zNjQtLjQ2Mi0uMTU4LTEuMDA4LjY1Ni0uNzIyLjg4MS4wNi4yMjUuMDYxLjg5My42ODYgMS45MDggMS40NzYgMi40OTEgMS44MzMuMzY1LjMwNC4xNDUtLjEwMy4wMTktLjA3My0uMTY0LS4yNzQtMS4zNTUtMi40NDYtMS40NDYtMi40OS0uNjQ0LTEuMDMyLS4xNy0uNjE5YTIuOTcgMi45NyAwIDAxLS4xMDQtLjcyOUw2LjI4My4xMzQgNi42OTYgMGwuOTk2LjEzNC40Mi4zNjQuNjIgMS40MTQgMS4wMDIgMi4yMjkgMS41NTUgMy4wMy40NTYuODk4LjI0My44MzIuMDkxLjI1NWguMTU4VjkuMDFsLjEyOC0xLjcwNi4yMzctMi4wOTUuMjMtMi42OTUuMDgtLjc2LjM3Ni0uOTEuNzQ3LS40OTIuNTg0LjI4LjQ4LjY4NS0uMDY3LjQ0NC0uMjg2IDEuODUxLS41NTkgMi45MDMtLjM2NCAxLjk0MmguMjEybC4yNDMtLjI0Mi45ODUtMS4zMDYgMS42NTItMi4wNjQuNzMtLjgyLjg1LS45MDQuNTQ3LS40MzFoMS4wMzNsLjc2IDEuMTI5LS4zNCAxLjE2Ni0xLjA2NCAxLjM0Ny0uODgxIDEuMTQyLTEuMjY0IDEuNy0uNzkgMS4zNi4wNzMuMTEuMTg4LS4wMiAyLjg1Ni0uNjA2IDEuNTQzLS4yOCAxLjg0MS0uMzE1LjgzMy4zODguMDkxLjM5NS0uMzI4LjgwNy0xLjk2OS40ODYtMi4zMDkuNDYyLTMuNDM5LjgxMy0uMDQyLjAzLjA0OS4wNjEgMS41NDkuMTQ2LjY2Mi4wMzZoMS42MjJsMy4wMi4yMjUuNzkuNTIyLjQ3NC42MzgtLjA3OS40ODUtMS4yMTUuNjItMS42NC0uMzg5LTMuODI5LS45MS0xLjMxMi0uMzI5aC0uMTgydi4xMWwxLjA5MyAxLjA2OCAyLjAwNiAxLjgxIDIuNTA5IDIuMzMuMTI3LjU3OC0uMzIyLjQ1NS0uMzQtLjA0OS0yLjIwNS0xLjY1Ny0uODUxLS43NDctMS45MjYtMS42MmgtLjEyOHYuMTdsLjQ0NC42NDkgMi4zNDUgMy41MjEuMTIyIDEuMDgtLjE3LjM1My0uNjA4LjIxMy0uNjY4LS4xMjItMS4zNzQtMS45MjUtMS40MTUtMi4xNjctMS4xNDMtMS45NDMtLjE0LjA4LS42NzQgNy4yNTQtLjMxNi4zNy0uNzI5LjI4LS42MDctLjQ2MS0uMzIyLS43NDcuMzIyLTEuNDc2LjM4OS0xLjkyNC4zMTUtMS41My4yODYtMS45LjE3LS42MzItLjAxMi0uMDQyLS4xNC4wMTgtMS40MzQgMS45NjctMi4xOCAyLjk0NS0xLjcyNiAxLjg0NS0uNDE0LjE2NC0uNzE3LS4zNy4wNjctLjY2Mi40MDEtLjU4OSAyLjM4OC0zLjAzNiAxLjQ0LTEuODgyLjkzLTEuMDg2LS4wMDYtLjE1OGgtLjA1NUw0LjEzMiAxOC41NmwtMS4xMy4xNDYtLjQ4Ny0uNDU2LjA2MS0uNzQ2LjIzMS0uMjQzIDEuOTA4LTEuMzEyLS4wMDYuMDA2eiIgZmlsbD0iI0Q5Nzc1NyIgZmlsbC1ydWxlPSJub256ZXJvIi8+PC9zdmc+Cg==`,
  codex: `data:image/svg+xml;base64,PHN2ZyBmaWxsPSJjdXJyZW50Q29sb3IiIGZpbGwtcnVsZT0iZXZlbm9kZCIgaGVpZ2h0PSI2NCIgd2lkdGg9IjY0IiB2aWV3Qm94PSIwIDAgMjQgMjQiIHhtbG5zPSJodHRwOi8vd3d3LnczLm9yZy8yMDAwL3N2ZyI+PHBhdGggZD0iTTkuMjA1IDguNjU4di0yLjI2YzAtLjE5LjA3Mi0uMzMzLjIzOC0uNDI4bDQuNTQzLTIuNjE2Yy42MTktLjM1NyAxLjM1Ni0uNTIzIDIuMTE3LS41MjMgMi44NTQgMCA0LjY2MiAyLjIxMiA0LjY2MiA0LjU2NiAwIC4xNjcgMCAuMzU3LS4wMjQuNTQ3bC00LjcxLTIuNzU5YS43OTcuNzk3IDAgMDAtLjg1NiAwbC01Ljk3IDMuNDczem0xMC42MDkgOC44VjEyLjA2YzAtLjMzMy0uMTQzLS41Ny0uNDI5LS43MzdsLTUuOTctMy40NzMgMS45NS0xLjExOGEuNDMzLjQzMyAwIDAxLjQ3NiAwbDQuNTQzIDIuNjE3YzEuMzA5Ljc2IDIuMTg5IDIuMzc4IDIuMTg5IDMuOTQ4IDAgMS44MDgtMS4wNyAzLjQ3My0yLjc2IDQuMTYzek03LjgwMiAxMi43MDNsLTEuOTUtMS4xNDJjLS4xNjctLjA5NS0uMjM5LS4yMzgtLjIzOS0uNDI4VjUuODk5YzAtMi41NDUgMS45NS00LjQ3MiA0LjU5MS00LjQ3MiAxIDAgMS45MjcuMzMzIDIuNzEyLjkyOEw4LjIzIDUuMDY3Yy0uMjg1LjE2Ni0uNDI4LjQwNC0uNDI4LjczN3Y2Ljg5OHpNMTIgMTUuMTI4bC0yLjc5NS0xLjU3di0zLjMzTDEyIDguNjU4bDIuNzk1IDEuNTd2My4zM0wxMiAxNS4xMjh6bTEuNzk2IDcuMjNjLTEgMC0xLjkyNy0uMzMyLTIuNzEyLS45MjdsNC42ODYtMi43MTJjLjI4NS0uMTY2LjQyOC0uNDA0LjQyOC0uNzM3di02Ljg5OGwxLjk3NCAxLjE0MmMuMTY3LjA5NS4yMzguMjM4LjIzOC40Mjh2NS4yMzNjMCAyLjU0NS0xLjk3NCA0LjQ3Mi00LjYxNCA0LjQ3MnptLTUuNjM3LTUuMzAzbC00LjU0NC0yLjYxN2MtMS4zMDgtLjc2MS0yLjE4OC0yLjM3OC0yLjE4OC0zLjk0OEE0LjQ4MiA0LjQ4MiAwIDAxNC4yMSA2LjMyN3Y1LjQyM2MwIC4zMzMuMTQzLjU3MS40MjguNzM4bDUuOTQ3IDMuNDQ5LTEuOTUgMS4xMThhLjQzMi40MzIgMCAwMS0uNDc2IDB6bS0uMjYyIDMuOWMtMi42ODggMC00LjY2Mi0yLjAyMS00LjY2Mi00LjUxOSAwLS4xOS4wMjQtLjM4LjA0Ny0uNTdsNC42ODYgMi43MWMuMjg2LjE2Ny41NzEuMTY3Ljg1NiAwbDUuOTctMy40NDh2Mi4yNmMwIC4xOS0uMDcuMzMzLS4yMzcuNDI4bC00LjU0MyAyLjYxNmMtLjYxOS4zNTctMS4zNTYuNTIzLTIuMTE3LjUyM3ptNS44OTkgMi44M2E1Ljk0NyA1Ljk0NyAwIDAwNS44MjctNC43NTZDMjIuMjg3IDE4LjMzOSAyNCAxNS44NCAyNCAxMy4yOTZjMC0xLjY2NS0uNzEzLTMuMjgyLTEuOTk4LTQuNDQ4LjExOS0uNS4xOS0uOTk5LjE5LTEuNDk4IDAtMy40MDEtMi43NTktNS45NDctNS45NDYtNS45NDctLjY0MiAwLTEuMjYuMDk1LTEuODguMzFBNS45NjIgNS45NjIgMCAwMDEwLjIwNSAwYTUuOTQ3IDUuOTQ3IDAgMDAtNS44MjcgNC43NTdDMS43MTMgNS40NDcgMCA3Ljk0NSAwIDEwLjQ5YzAgMS42NjYuNzEzIDMuMjgzIDEuOTk4IDQuNDQ4LS4xMTkuNS0uMTkgMS0uMTkgMS40OTkgMCAzLjQwMSAyLjc1OSA1Ljk0NiA1Ljk0NiA1Ljk0Ni42NDIgMCAxLjI2LS4wOTUgMS44OC0uMzA5YTUuOTYgNS45NiAwIDAwNC4xNjIgMS43MTN6Ii8+PC9zdmc+Cg==`,
  omp: `data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iNjQiIGhlaWdodD0iNjQiIHZpZXdCb3g9IjAgMCA2NCA2NCIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIiBhcmlhLWhpZGRlbj0idHJ1ZSI+PGRlZnM+PGxpbmVhckdyYWRpZW50IGlkPSJnaWQtb21wLWdyYWRpZW50IiB4MT0iMCIgeTE9IjAiIHgyPSIxIiB5Mj0iMSI+PHN0b3Agb2Zmc2V0PSIwIiBzdG9wLWNvbG9yPSJva2xjaCgwLjcgMC4yNCAzNDApIi8+PHN0b3Agb2Zmc2V0PSIuNSIgc3RvcC1jb2xvcj0ib2tsY2goMC42MiAwLjIxIDI5NSkiLz48c3RvcCBvZmZzZXQ9IjEiIHN0b3AtY29sb3I9Im9rbGNoKDAuODEgMC4xNCAyMDApIi8+PC9saW5lYXJHcmFkaWVudD48L2RlZnM+PHBhdGggZmlsbD0idXJsKCNnaWQtb21wLWdyYWRpZW50KSIgZD0iTTEwIDE0aDQ0djlINDN2MzNoLTlWMjNoLTl2MjJoLTlWMjNIMTB6Ii8+PC9zdmc+Cg==`,
  pi: `data:image/svg+xml;base64,PHN2ZyBoZWlnaHQ9IjY0IiB3aWR0aD0iNjQiIHZpZXdCb3g9IjAgMCA4MDAgODAwIiB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciPjxwYXRoIGZpbGw9IiNGRkZGRkYiIGZpbGwtcnVsZT0iZXZlbm9kZCIgZD0iTTE2NS4yOSAxNjUuMjkgSDUxNy4zNiBWNDAwIEg0MDAgVjUxNy4zNiBIMjgyLjY1IFY2MzQuNzIgSDE2NS4yOSBaIE0yODIuNjUgMjgyLjY1IFY0MDAgSDQwMCBWMjgyLjY1IFoiLz48cGF0aCBmaWxsPSIjRkZGRkZGIiBkPSJNNTE3LjM2IDQwMCBINjM0LjcyIFY2MzQuNzIgSDUxNy4zNiBaIi8+PC9zdmc+Cg==`,
  hermes: `data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAMAAACdt4HsAAAAPFBMVEVzc3Pn5+ccHBszMzMBAQH///8AAAAYGBgLCwscHBxLS0vGxsbX19dfX19+fn7z8/OgoKCysrKGhoaSkpIgp1CAAAAACnRSTlP9////ff//gICA//OAVQAABGdJREFUWIWll4uWnCAMQANUuiXh/f//2gRQAZ1te8rZs6MOXPNOBn7Af60f8Cse/7HUF/xUn76MmIJ3zodM/w6IRDml4uxYgO+CfgBQShnba1U6ESa9IV4BebxXB/lK+QuBfwXI2t6rypOy3n4PIGeX5eTbcN36PwGS3ZcWzS8tLHwLiP5xnDVnQtTnrU7fAJTZT2vtq5eX5v5Ae4v4EaBMe89N8c5mMaoccSKMNiGpED8BjNO6ndKDYUhsZsHwf7SWTVlEm/QBUCoTjE38KvBOGOnIKpJxSkKqpphTjCyQia8AQiJvTMrVGeRHThIgskLGuiL+0Zg0uMTo/ArI/KFqbW+jopTsihGaI8SVirXjS8cAH18AlChGRVB9CRokgkz1tQ5rdDNa/muGohcAeO0L6OGD0+1mXJRDEQe0k7BgQHkBaDf5z27xbD00J8hzPWJrA9Dlu+7AjaCT9m6A9VBpBdRL7H4grAC2CHuAwabvCw8AbAeSXm61JAmf1q4D3ANwZdE4CHUFdN3ZGONefQaMK1pFuFXpn/hZhVFHfbeCeRCGii9GPBd5KLaqI0EpIe+EISDsADo3tNJbsTifh7NXXYYO5hFIvlmqUE+U3EpRV3TIMOLktJHaAapJB1jbKRLRi4V4AQIi+UkH3AFcj0wSo41UKxyvQJMEdrjYd5XqA8AZn9Em0+I8YoYS6MUGLRjtHUprVVY2lO4gzmw1jLg7cujwCkBrpkztK34A0Bsg28f528GbI9MbILFt9hacd8AQwb8BqlUYt2Hi6qx6Beg3ANgY9xa+F6crHegF4Cwbf7Ph5sVWFScjrAAu+Rj6ZHLaYrehVIYugnsC+G2eG5yBSQ1c9Ze6IlkhUsQHgPPBqoQHTmr0PL8tKScF4Ec6LAARN6h1lmqVxuAsQasyeVTWBdC2TePG5YSibgmGQqh7TRiAPgS2+WadYboT6JpQWmltgNCN0AHU63yY/HsCesyco9M16VjM3QgdUHoKzO6Z7Gr9FUy3N5D1TQoHwIdrs+wnTuZcId9hkGEHEErL9QPgzGWCeeUB4CKVt/M2ZjFXyQ3A013oe/UauNRtQE+4kSrsj+SjABScRbfs25pnHW7P+eVChqOaLkEYhbOWtUlbsO8dzqIYJRyg1c9mg96Asmixpi88ClJbukV4OkyXgDVE5BxoVlgaPSxNbwK0/+wJPyLRW5e6q+rcDOvh1TuhUThw8gBcU/aUNrbyZJm5bOCjRfeV2JPxSibsfSvOJohovKYRDM61YdmFU0dNYoUpG8lRXGcldhN3Kw4iFwqbHZCUwlJ6j7TJSWWe09k6EGEnKyJVUSCTwrudkpFMlARxcQV09dMUNO5g/7KYMgVODVAn1038KGkVCh2zybR1dCiltJ2LteKR3obR1B+/2u5O5NhLKJ360GuRYLXc2QMfgLsPmNrV9px4e7cBNw0Y64/v4UbIPKy2ccenAx4tV10/hBnwBeFe47zj4V3rwg+8haJ92Fc5L+DrN9ijZSiX90rqAAAAAElFTkSuQmCC`,
  agy: `data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAMAAACdt4HsAAABYlBMVEVHcEw5iPw2i/IziPztaDo3ifeJwGA6iPhkhug3ifjtVEg6ivgujO00h/8wivRztHQ0iftrgdLrhy41ifA0iPs+mMJNrp7rWEgwifjgryrcVmJ4wXDiUlmPeMCGxWK3w0FhprPZVmJato0pktxVjflCqKqjbqeLxWKQeL/opSZBp6z1Uj3Xuy01ifwwiPg1h/87if8wh/wvivRCiv4vi+8zktxNjPsvjek1ltEwj+Q5nMTwV0BDpK9Rg+hZifJ5e8tMq6C7ZHk+h/k2h/nOW2lXsJBAn7mGdrx1vG9dgd1Jh/SebZ3lU07meDlitoKuZo1kfszdWlOgvlBWk69wgttBhe/Ia14/iOTaZ01Cj87gpSxzfbOHdqeVcaxMh9O7uz90loxwiKFah77GelWfrVdToKGSe4uud2+kcIXlky6Sm22+qENyp37Mh0iHq2pfpo6tmVeuh2LSszGJhonJlkKWi3VeO12PAAAALXRSTlMARBro/o/8f/1lxVMt8q79vAf6/cv6i23YVBo4QcePmg6TzuC5S3QaM6re4bufpM1dAAADxklEQVRYhZ2X+T9iURTAXz2VVIQYxowxY4wxM7wShWwVSrIvlchStopR+P/n3O0t3tqcH933/d5zzj339sFxBjE40dOz3dbxwegbI/z09AEE221tsf9STJyC4IEIYh2t83+aTVEAht+t8l+aRPC4TVJoNYfBi4tms3b6+voIhjw2fG1JcAFRq9WwoJxv2wdB7GMrBcgE5e18Pr8fy7ZSxPgBRKVSe35+fmyUy2VsiMU+WU8A85UKCBpIcAKCbDZrOYURkkDlqfpcbSDDyUl+HxmspjB84HQ6nyCq1epbo3F3d0INVlNwyniIO2RYW0OGbkv8kNOZTnd1ddXr9cvLt5e3WzDEicHanRjGfB3zl5cvL7e39/fxeBwMFmvA/E79LwQIrmSGtX0rwzSUTqd3dtYBv7k5PLyCOEOGXWywUEP3MObXAUcCMBSvzs62qMFKDV0if4ji+rpYLIJhaxcbzPlxzK+uLi5ubBz2AS8z7MbXzGepX+L7+gqFAjLsIcM5TsL8Un9T8oVSqbS3t7dSTFGDqYDxCwtzc8DnmCGVOscGs4MckvjC3OzsbC6XWyqVNsFAFLs/zFog7Y/w+RwyLG1Khs9mLZDx8/PRaDSHFZugoAZjvlvOR6Mzvb29x8fHS0s4CWRInf80FIwp+RlqOMaGoxWkMG5Cv5Kfnp5KJpMJ0QCKlHETfsl5wKeQIJkARYYYQGHEj0j8DOGxAAyZDBja25HAqAlj8v0RHgqFiAAZlrHhyGXUAjUPIYiG5XZQGDWhT1F/iPKCMCk3tOs/rXbF/qGQz+9wu12dvDAZDCbCCSRACpuuwE3nj/C8h/3dFhCCwWA4HIlEkMGhK+iU56/4zI0F4Qwx6AogAbw/4t3KJRsxkBzsOrxXxqvOSm5wa9EQDjpAwHeqV11YgAyR7zqCUfEAfFrLAZZCJKJ9kHapgZoHZReLiHi01jmX2AC/doYu0aBdwyi7QSG9LvvENmiterUnQB50GsLaNTjEG6A/6zwzaBXJTlA9AlLYBGYYUa15WAJJfZ7jBphBvcsAK0BvzHB4BWRACtUKK4A34jnOzwzv9/GzBPQvOw67QA3vNvIyPmDMw2ERQTCsPMkA8NPoDdObISl8NAdFCh46gkZHyMImCEQh/7aX8gPmPLxbzCBl20l+RKwUwIpACrFfbsZr31JVeAVqoJfGy34E9F/bd+GhBgEPg53xGs+YXriYAU0NT/PXeUW0w8EM3Zyr9f3lOTg4fqq1+lm4icDHEd7kBmiFF58mz9n40IDL2r8yqiQCvN/+D+aPcPZ+RgT3AAAAAElFTkSuQmCC`,
}

/**
 * The DSH fish silhouette (FishLogo geometry, tight 23.16:17.04 viewBox) at
 * the official site's brand blue.
 *
 * @param props - `size`: width in pixels (height keeps the native ratio).
 * @returns the blue fish mark.
 */
export function DshFish({ size }: { size: number }): React.JSX.Element {
  return (
    <svg
      width={size}
      height={(size * 17.04) / 23.16}
      viewBox="0 0 23.16 17.04"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
      style={{ display: 'block', flex: 'none' }}
    >
      <path
        fill="#4D6BFE"
        d="M22.9168 1.43018C22.6713 1.31018 22.5658 1.53918 22.4223 1.65519C22.3733 1.69269 22.3318 1.74169 22.2903 1.78669C21.9317 2.1697 21.5127 2.42121 20.9657 2.39121C20.1657 2.34621 19.4827 2.59771 18.8787 3.20973C18.7502 2.45521 18.3236 2.0047 17.6746 1.71569C17.3351 1.56568 16.9916 1.41518 16.7536 1.08867C16.5876 0.856163 16.5421 0.597155 16.4591 0.341647C16.4061 0.187643 16.3536 0.0301382 16.1761 0.00363739C15.9836 -0.0263635 15.9081 0.135141 15.8326 0.270145C15.5306 0.822162 15.4136 1.43018 15.4251 2.0462C15.4516 3.43174 16.0366 4.53527 17.1991 5.3203C17.3311 5.4103 17.3651 5.5003 17.3236 5.63181C17.2441 5.90231 17.1501 6.16482 17.0671 6.43533C17.0141 6.60784 16.9351 6.64584 16.7501 6.57033C16.1121 6.30383 15.5611 5.90931 15.074 5.4328C14.2475 4.63328 13.5 3.75075 12.568 3.05973C12.349 2.89822 12.13 2.74822 11.9034 2.60522C10.9524 1.68169 12.028 0.923165 12.277 0.833162C12.5375 0.739159 12.3675 0.41615 11.5259 0.42015C10.6844 0.42365 9.91439 0.705658 8.93286 1.08117C8.78935 1.13767 8.63835 1.17867 8.48384 1.21267C7.59332 1.04367 6.66829 1.00617 5.70226 1.11517C3.88321 1.31768 2.43016 2.1777 1.36213 3.64575C0.0790928 5.4103 -0.222916 7.41536 0.146595 9.50642C0.535106 11.7105 1.66014 13.535 3.38869 14.9616C5.18125 16.4406 7.24581 17.1657 9.60138 17.0266C11.0319 16.9441 12.6245 16.7526 14.421 15.2321C14.874 15.4576 15.3496 15.5476 16.1381 15.6151C16.7456 15.6716 17.3306 15.5851 17.7836 15.4911C18.4931 15.3411 18.4441 14.6841 18.1876 14.5636C16.1081 13.595 16.5646 13.9891 16.1496 13.67C17.2061 12.42 18.8202 10.1979 19.3182 7.17235C19.3672 6.83834 19.4297 6.36783 19.4222 6.09732C19.4182 5.93231 19.4562 5.86831 19.6447 5.84931C20.1657 5.78931 20.6712 5.64681 21.1357 5.3913C22.4833 4.65528 23.0268 3.44624 23.1548 1.9972C23.1738 1.77569 23.1508 1.54668 22.9168 1.43018ZM11.1749 14.4736C9.15936 12.889 8.18184 12.3675 7.77832 12.39C7.40081 12.4125 7.46881 12.8445 7.55182 13.126C7.63882 13.404 7.75182 13.5955 7.91033 13.8396C8.01983 14.0011 8.09533 14.2411 7.80083 14.4216C7.15181 14.8231 6.02327 14.2866 5.97027 14.2601C4.65673 13.4865 3.5587 12.4655 2.78467 11.069C2.03715 9.72493 1.60314 8.28289 1.53164 6.74384C1.51264 6.37233 1.62214 6.24082 1.99215 6.17332C2.47916 6.08332 2.98118 6.06432 3.46769 6.13582C5.52476 6.43633 7.27581 7.35586 8.74385 8.8129C9.58188 9.64243 10.2159 10.634 10.8689 11.6025C11.5634 12.631 12.3105 13.611 13.262 14.4146C13.598 14.6961 13.866 14.9101 14.1225 15.0681C13.349 15.1546 12.058 15.1731 11.1749 14.4746L11.1749 14.4736ZM12.141 8.25988C12.141 8.09488 12.273 7.96338 12.439 7.96338C12.4765 7.96338 12.5105 7.97088 12.541 7.98188C12.5825 7.99688 12.6205 8.01938 12.6505 8.05338C12.7035 8.10588 12.7335 8.18088 12.7335 8.25988C12.7335 8.42489 12.6015 8.55639 12.4355 8.55639C12.2695 8.55639 12.141 8.42489 12.141 8.25988ZM15.1415 9.79893C14.949 9.87793 14.7565 9.94544 14.5715 9.95294C14.2845 9.96794 13.9715 9.85143 13.8015 9.70893C13.5375 9.48742 13.3485 9.36342 13.2695 8.97691C13.2355 8.8119 13.2545 8.55639 13.2845 8.40989C13.3525 8.09438 13.277 7.89187 13.0545 7.70787C12.8735 7.55786 12.6435 7.51636 12.39 7.51636C12.2955 7.51636 12.2095 7.47486 12.1445 7.44136C12.0395 7.38886 11.9519 7.25735 12.035 7.09585C12.0615 7.04335 12.19 6.91584 12.22 6.89334C12.5635 6.69784 12.9595 6.76184 13.326 6.90834C13.6655 7.04735 13.9225 7.30236 14.292 7.66287C14.6695 8.09838 14.7375 8.21838 14.9525 8.54539C15.1225 8.8009 15.2775 9.06341 15.3831 9.36392C15.4471 9.55142 15.3641 9.70493 15.1415 9.79893Z"
      />
    </svg>
  )
}

/** Opaque tile backgrounds for marks that would vanish on a dark frame. */
const RUNTIME_TILE_BG: Readonly<Record<string, string>> = {
  codex: '#FFFFFF',
  pi: '#000000',
}

/** Sanitized useId: raw React ids contain colons, kept out of url(#…) refs. */
function useGlyphId(): string {
  return `superd_subagent_${React.useId().replaceAll(':', '')}`
}

/**
 * The subagent mark: two stacked rounded squares (the Plugins page's
 * subagent artwork, redrawn in-bundle) — the default foreign-agent icon.
 *
 * @param props - `size`: square edge in pixels.
 * @returns the subagent mark.
 */
export function SubagentGlyph({ size }: { size: number }): React.JSX.Element {
  const uid = useGlyphId()
  return (
    <svg
      width={size}
      height={size}
      viewBox="8.47 8.67 19.16 19.16"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
      style={{ display: 'block', flex: 'none' }}
    >
      <rect x="14.99" y="15.19" width="12.24" height="12.24" rx="2.4" fill={`url(#${uid}a)`} fillOpacity="0.85" />
      <rect x="8.87" y="9.07" width="12.24" height="12.24" rx="2.4" fill={`url(#${uid}b)`} fillOpacity="0.85" />
      <defs>
        <linearGradient id={`${uid}a`} x1="21.11" y1="15.19" x2="21.11" y2="27.42" gradientUnits="userSpaceOnUse">
          <stop stopColor="#45E7A4" />
          <stop offset="1" stopColor="#05909D" />
        </linearGradient>
        <linearGradient id={`${uid}b`} x1="14.99" y1="9.07" x2="14.99" y2="21.31" gradientUnits="userSpaceOnUse">
          <stop stopColor="#69B9FF" />
          <stop offset="1" stopColor="#324DE2" />
        </linearGradient>
      </defs>
    </svg>
  )
}

/** One embedded square image mark at the requested edge. */
function imgMark(uri: string, size: number): React.JSX.Element {
  return (
    <img
      src={uri}
      alt=""
      width={size}
      height={size}
      style={{ display: 'block', flex: 'none', objectFit: 'contain' }}
    />
  )
}

/**
 * Render one runtime's mark: the DSH app icon for native (scheme-aware), the
 * curated asset for a matching roster key, the subagent mark otherwise.
 *
 * @param props - `agentKey`: the roster key; `size`: square edge in pixels.
 * @returns the runtime mark.
 */
export function RuntimeMark({ agentKey, size }: { agentKey: string; size: number }): React.JSX.Element {
  if (agentKey === 'native') return <DshFish size={size} />
  // An SDK half is the SAME agent through a different transport, so it carries
  // the same mark: roster keys are `<runtime>` and `<runtime>-sdk` (the two
  // lines ship beside each other, and the hub's registerAgent hard-throws on a
  // duplicate key), and inventing artwork per transport would claim the agent
  // differs when only the plumbing does.
  const base = agentKey.endsWith('-sdk') ? agentKey.slice(0, -'-sdk'.length) : agentKey
  const uri = RUNTIME_ICON_URIS[base]
  if (uri === undefined) return <SubagentGlyph size={size} />
  const tile = RUNTIME_TILE_BG[base]
  if (tile === undefined) return imgMark(uri, size)
  // Marks whose own ink would vanish on a dark frame carry an opaque tile:
  // Codex's black glyph on white, Pi's white glyph on black.
  return (
    <span
      aria-hidden="true"
      style={{
        width: size,
        height: size,
        flex: 'none',
        borderRadius: Math.max(3, Math.round(size * 0.2)),
        background: tile,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      {imgMark(uri, Math.round(size * 0.74))}
    </span>
  )
}
