// Stub for @earendil-works/pi-tui.
// The widget code does `new Text(text, 0, 0).render(width)` and expects a
// string back. We provide just enough of that surface for the file to load.
export class Text {
  constructor(text, _x, _y) {
    this.text = text;
  }
  render(_width) {
    return this.text;
  }
}