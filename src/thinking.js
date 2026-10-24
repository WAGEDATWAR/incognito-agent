// Reasoning is sent as ONE thought update: the IDE draws every thought chunk as its own "thought" block.
export class ThoughtBuffer {
  constructor(emit) { this.emit = emit; this.text = ''; }
  add(t) { this.text += t; }
  end() {
    if (this.text) this.emit(this.text);
    this.text = '';
  }
}
