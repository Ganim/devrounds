// The on-screen keyboard shrinks the visual viewport but not the layout one on iOS: publish its height (--vvh) and the
// keyboard's (--kb) so a bottom sheet sits above the keyboard instead of under it (cx-env page-v2.html, visualViewport
// block; P5 design §3 call 9).
export function publishViewport() {
  const vv = window.visualViewport
  if (!vv) return
  const sync = () => {
    const root = document.documentElement.style
    root.setProperty('--vvh', `${vv.height}px`)
    root.setProperty('--kb', `${Math.max(0, window.innerHeight - vv.height - vv.offsetTop)}px`)
  }
  vv.addEventListener('resize', sync)
  vv.addEventListener('scroll', sync)
  sync()
}
