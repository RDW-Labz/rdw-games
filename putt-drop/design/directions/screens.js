// Tiny local preview interactions. The course remains a static, mid-drag study.
for (const button of document.querySelectorAll('[data-dialog]')) {
  button.addEventListener('click', () => document.getElementById(button.dataset.dialog).showModal());
}
// Tell the comparison page when custom fonts have actually loaded.
document.fonts.ready.then(() => document.documentElement.dataset.fonts = 'ready');
