// The colour theme, set before the page is drawn so it never flashes the other one: Light or Dark
// when one was chosen with the header's theme button (kept in this browser), otherwise the system's.
// app.js draws that button, and follows the system's changes while the choice is Auto.
{
  let chosen = null;
  try {
    chosen = localStorage.getItem("plumbergui-theme");
  } catch {
    // Storage is blocked: follow the system
  }
  const dark = chosen === "dark" || (chosen !== "light" && matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.setAttribute("data-theme", dark ? "dark" : "light");
}
