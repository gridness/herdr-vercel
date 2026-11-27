import { View, div } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { appHome, checking, closeOverlay, exec, pickFiles, props, readTextFile, theme, writeTextFile } from "herdr";

const formats = { png: "png", jpg: "jpeg", jpeg: "jpeg", webp: "webp" };
const maxBytes = 48 * 1024 * 1024;
const maxPixels = 36_000_000;

async function validateImage(path) {
  const extension = /\.(png|jpe?g|webp)$/i.exec(path)?.[1].toLowerCase();
  if (!path.startsWith("/") || !extension) {
    throw new Error("Choose a PNG, JPEG, or WebP image.");
  }

  // ASVS 1.2.5, 5.2.1, 5.2.2: pass the local path as an argument and check size and format before rendering.
  const stat = await exec("/usr/bin/stat", ["-Lf", "%HT %z", "--", path]);
  const bytes = /^Regular File (\d+)\s*$/.exec(stat.stdout)?.[1];
  if (stat.code !== 0 || !Number(bytes)) throw new Error("Choose a readable image file.");
  if (Number(bytes) > maxBytes) throw new Error("Choose an image under 48 MiB.");

  const info = await exec("/usr/bin/sips", ["-g", "format", "-g", "pixelWidth", "-g", "pixelHeight", path]);
  const format = /^  format: (\w+)$/m.exec(info.stdout)?.[1];
  const width = Number(/^  pixelWidth: (\d+)$/m.exec(info.stdout)?.[1]);
  const height = Number(/^  pixelHeight: (\d+)$/m.exec(info.stdout)?.[1]);
  if (info.code !== 0 || format !== formats[extension] || !width || !height) {
    throw new Error("Herdr couldn't read that image. Choose a different file.");
  }
  if (width * height > maxPixels) throw new Error("Choose an image up to 36 megapixels.");
}

function findTabFrame(node) {
  if (node.id === "main" && node.content?.tab === "active") return node.content.pane;
  for (const child of node.children ?? []) {
    const frame = findTabFrame(child);
    if (frame) return frame;
  }
  return null;
}

async function readLayout() {
  const path = `${appHome()}/layouts/vercel.json`;
  const original = await readTextFile(path);
  if (original === null) throw new Error("Install the Vercel layout to set its background.");
  const layout = JSON.parse(original);
  const frame = findTabFrame(layout);
  if (!frame) throw new Error("The Vercel layout needs an active terminal pane frame.");
  return { path, original, layout, frame };
}

export default class VercelBackground extends View {
  init(_props, cx) {
    this.image = null;
    this.busy = false;
    this.error = null;
    this.ready = checking();
    this.focus = cx.focus_handle();
    this.focus.focus();
    if (this.ready) return;
    cx.spawn(async (cx) => {
      try {
        const { frame } = await readLayout();
        this.image = frame.background?.image ?? null;
        this.ready = true;
      } catch (error) {
        this.error = error.message;
      }
      cx.notify();
    });
  }

  change(cx, remove = false) {
    if (!this.ready || this.busy) return;
    this.busy = true;
    this.error = null;
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        const image = remove ? null : (await pickFiles({ prompt: "Set Background" }))?.[0];
        if (image === undefined) return;
        if (image) await validateImage(image);
        const { path, original, layout, frame } = await readLayout();
        frame.background = image ? { image, fit: "cover" } : "background";
        layout.terminal_opacity = image ? 0.68 : 1;
        // ASVS 1.2.3: serialize the selected path as JSON and reject a stale config write.
        await writeTextFile(path, `${JSON.stringify(layout, null, 2)}\n`, original);
        this.image = image;
        closeOverlay(props().overlay);
      } catch (error) {
        this.error = error.message;
      } finally {
        this.busy = false;
        cx.notify();
      }
    });
  }

  render() {
    const t = theme();
    const button = (id, label, primary, action, disabled = false) => h_flex().id(id)
      .h(32).px(12).items_center().rounded(6).border_1().font_medium()
      .border_color(primary ? t.solid : t.border)
      .bg(primary ? t.solid : t.surface)
      .text_color(primary ? t.solid_foreground : t.foreground)
      .when(disabled, el => el.opacity(0.55))
      .when(!disabled, el => el.cursor_pointer().hover(s => s.opacity(0.82)).on_click(action))
      .child(label);
    const disabled = this.busy || !this.ready;
    const imageName = this.image?.split("/").pop();
    return v_flex().id("vercel-background").track_focus(this.focus)
      .size_full().p(18).gap(8).text_size(13).text_color(t.foreground)
      .on_key_down((e, cx) => {
        if (e.key === "enter" && !disabled) {
          cx.stop_propagation();
          this.change(cx);
        }
      })
      .child(div().text_size(16).font_semibold().child("Terminal background"))
      .child(div().w_full().truncate().text_color(this.error ? t.blocked : t.muted)
        .child(this.error ?? (imageName ? `Current image: ${imageName}` : "Use a PNG, JPEG, or WebP in the Vercel layout.")))
      .child(div().flex_1())
      .child(h_flex().justify_end().gap(8)
        .when(Boolean(this.image), el => el.child(button("remove", "Remove image", false, (_e, cx) => this.change(cx, true), disabled)))
        .child(button("close", "Close", false, () => closeOverlay(props().overlay)))
        .child(button("choose", this.busy ? "Working…" : "Choose image…", true, (_e, cx) => this.change(cx), disabled)));
  }
}
