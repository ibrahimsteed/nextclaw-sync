/**
 * 设置页测试用的 Obsidian 替身：只实现 settings.ts 用到的那部分 API，
 * 记录下创建了哪些设置项、挂在哪个容器里、控件是否被禁用。
 *
 * `obsidian` 包只有类型、没有运行时代码，所以测试里要先调用
 * `installFakeObsidian()`，再 require 被测模块。
 */
import Module from "module";

type Fn = (...args: any[]) => any;

export class FakeEl {
  children: FakeEl[] = [];
  classes = new Set<string>();
  shown = true;
  text?: string;
  setting?: Setting;
  listeners: Record<string, Fn[]> = {};
  parent?: FakeEl;
  type = "text";
  rows = 0;
  constructor(readonly tag = "div") {}
  createEl(tag: string, o?: { text?: string; cls?: string }) {
    const e = new FakeEl(tag);
    if (o?.text !== undefined) e.text = o.text;
    if (o?.cls !== undefined) e.classes.add(o.cls);
    e.parent = this;
    this.children.push(e);
    return e;
  }
  createDiv(o?: { text?: string; cls?: string }) {
    return this.createEl("div", o);
  }
  empty() {
    this.children = [];
  }
  setText(t: string) {
    this.text = t;
  }
  addClass(c: string) {
    this.classes.add(c);
  }
  hide() {
    this.shown = false;
  }
  show() {
    this.shown = true;
  }
  toggle(show: boolean) {
    this.shown = show;
  }
  isShown() {
    return this.shown;
  }
  addEventListener(type: string, fn: Fn) {
    (this.listeners[type] ??= []).push(fn);
  }
  dispatch(type: string) {
    for (const fn of this.listeners[type] ?? []) fn();
  }
  /** 本元素及所有祖先都可见。 */
  visible(): boolean {
    return this.shown && (this.parent?.visible() ?? true);
  }
  /** 按文档顺序列出子树中的设置项。 */
  settings(): Setting[] {
    const out: Setting[] = [];
    const walk = (e: FakeEl) => {
      if (e.setting && e !== this) out.push(e.setting);
      for (const c of e.children) walk(c);
    };
    walk(this);
    return out;
  }
  texts(): string[] {
    const out: string[] = [];
    const walk = (e: FakeEl) => {
      if (e.text !== undefined) out.push(e.text);
      for (const c of e.children) walk(c);
    };
    walk(this);
    return out;
  }
}

class ValueComponent {
  disabled = false;
  value = "";
  placeholder = "";
  onChangeFn?: Fn;
  inputEl = new FakeEl("input");
  setDisabled(v: boolean) {
    this.disabled = v;
    return this;
  }
  setValue(v: string) {
    this.value = v;
    return this;
  }
  getValue() {
    return this.value;
  }
  setPlaceholder(v: string) {
    this.placeholder = v;
    return this;
  }
  onChange(fn: Fn) {
    this.onChangeFn = fn;
    return this;
  }
  /** 模拟用户输入。 */
  async change(v: string) {
    this.value = v;
    await this.onChangeFn?.(v);
  }
}

export class TextComponent extends ValueComponent {}
export class TextAreaComponent extends ValueComponent {}
export class DropdownComponent extends ValueComponent {
  options: [string, string][] = [];
  addOption(v: string, label: string) {
    this.options.push([v, label]);
    return this;
  }
}
export class ButtonComponent {
  disabled = false;
  text = "";
  cta = false;
  clickFn?: Fn;
  setButtonText(t: string) {
    this.text = t;
    return this;
  }
  setCta() {
    this.cta = true;
    return this;
  }
  destructive = false;
  setDestructive() {
    this.destructive = true;
    return this;
  }
  setDisabled(v: boolean) {
    this.disabled = v;
    return this;
  }
  onClick(fn: Fn) {
    this.clickFn = fn;
    return this;
  }
  async click() {
    await this.clickFn?.();
  }
}
export class ExtraButtonComponent {
  icon = "";
  clickFn?: Fn;
  setIcon(i: string) {
    this.icon = i;
    return this;
  }
  onClick(fn: Fn) {
    this.clickFn = fn;
    return this;
  }
  click() {
    this.clickFn?.();
  }
}

export class Setting {
  settingEl: FakeEl;
  nameEl: FakeEl;
  name = "";
  desc = "";
  heading = false;
  components: any[] = [];
  constructor(containerEl: FakeEl) {
    this.settingEl = containerEl.createDiv();
    this.settingEl.setting = this;
    this.nameEl = this.settingEl.createDiv();
  }
  setName(n: string) {
    this.name = n;
    return this;
  }
  setDesc(d: string) {
    this.desc = d;
    return this;
  }
  setHeading() {
    this.heading = true;
    return this;
  }
  private add<T>(c: T, cb: (c: T) => unknown) {
    this.components.push(c);
    cb(c);
    return this;
  }
  addText(cb: (c: TextComponent) => unknown) {
    return this.add(new TextComponent(), cb);
  }
  addTextArea(cb: (c: TextAreaComponent) => unknown) {
    return this.add(new TextAreaComponent(), cb);
  }
  addDropdown(cb: (c: DropdownComponent) => unknown) {
    return this.add(new DropdownComponent(), cb);
  }
  addButton(cb: (c: ButtonComponent) => unknown) {
    return this.add(new ButtonComponent(), cb);
  }
  addExtraButton(cb: (c: ExtraButtonComponent) => unknown) {
    return this.add(new ExtraButtonComponent(), cb);
  }
  get text() {
    return this.components.find((c) => c instanceof TextComponent) as TextComponent;
  }
  get dropdown() {
    return this.components.find((c) => c instanceof DropdownComponent) as DropdownComponent;
  }
  get textArea() {
    return this.components.find((c) => c instanceof TextAreaComponent) as TextAreaComponent;
  }
  get buttons() {
    return this.components.filter((c) => c instanceof ButtonComponent) as ButtonComponent[];
  }
  get extraButton() {
    return this.components.find((c) => c instanceof ExtraButtonComponent) as ExtraButtonComponent;
  }
}

export class PluginSettingTab {
  containerEl = new FakeEl();
  constructor(
    readonly app: unknown,
    readonly plugin: unknown
  ) {}
  hide() {}
}

export class Modal {
  static opened: Modal[] = [];
  contentEl = new FakeEl();
  titleEl = new FakeEl();
  closed = false;
  constructor(readonly app: any) {}
  open() {
    Modal.opened.push(this);
    (this as any).onOpen?.();
  }
  close() {
    this.closed = true;
    (this as any).onClose?.();
  }
}

export class Notice {
  static messages: string[] = [];
  constructor(m: string) {
    Notice.messages.push(m);
  }
}

export const Platform = { isMobile: false };

let installed = false;
export const installFakeObsidian = () => {
  if (installed) return;
  installed = true;
  const fake = {
    Setting,
    PluginSettingTab,
    Modal,
    Notice,
    Platform,
  };
  const M = Module as unknown as { _load: Fn };
  const original = M._load;
  M._load = function (request: string, ...rest: unknown[]) {
    if (request === "obsidian") return fake;
    return original.call(this, request, ...rest);
  };
};
