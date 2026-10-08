// @effect-diagnostics nodeBuiltinImport:off globalTimers:off - owned by the Electron main process.
import type { DesktopComputerUseCursor } from "@t3tools/contracts";
import * as Context from "effect/Context";

/** One input-transparent panel. Each thread's one-shot motion and idle timer live in its renderer. */
const PAGE = `<!doctype html><meta charset="utf-8"><style>
html,body{margin:0;overflow:hidden;background:transparent;pointer-events:none;font:11px -apple-system,BlinkMacSystemFont,sans-serif}
.agent{position:absolute;left:0;top:0;opacity:0;will-change:transform;filter:drop-shadow(0 1px 2px #0008)}
.arrow{width:19px;height:24px;display:block}.tag{position:absolute;top:24px;left:9px;white-space:nowrap;max-width:180px;overflow:hidden;text-overflow:ellipsis;border-radius:5px;background:#20232bee;color:white;padding:3px 6px}
.badge{margin-left:5px;color:#dde5ee}.ripple{position:absolute;left:-9px;top:-9px;width:18px;height:18px;border:2px solid currentColor;border-radius:50%;opacity:0}
</style><script>
const agents=new Map(), colors=['#4c9aff','#e29aff','#38d6be','#ffbb66','#ff8199'];
const reduce=matchMedia('(prefers-reduced-motion: reduce)');
function colour(id){let h=0;for(const c of id)h=(h*31+c.charCodeAt(0))>>>0;return colors[h%colors.length]}
function remove(a){clearTimeout(a.timer);for(const x of a.node.getAnimations({subtree:true}))x.cancel();a.node.remove();agents.delete(a.id)}
window.removeAgentCursors=ids=>{for(const id of ids){const a=agents.get(id);if(a)remove(a)}};
window.viewCodeAgentCursor=async m=>{
 let a=agents.get(m.threadId);
 if(!a){
  if(agents.size>=32)remove(agents.values().next().value);
  const node=document.createElement('div');node.className='agent';node.style.color=colour(m.threadId);
  node.innerHTML='<svg class="arrow" viewBox="0 0 19 24"><path d="M1 1L17 15L10 16L8 22L1 1Z" fill="currentColor" stroke="white" stroke-width="1.5" stroke-linejoin="round"/></svg><div class="ripple"></div><div class="tag"><span class="name"></span><span class="badge"></span></div>';
  document.body.append(node);a={id:m.threadId,node,x:m.x,y:m.y,timer:null,generation:0};agents.set(m.threadId,a);
 }
 const generation=++a.generation;
 clearTimeout(a.timer);for(const x of a.node.getAnimations({subtree:true}))x.cancel();
 a.node.querySelector('.name').textContent=m.threadName.slice(0,100)||'Agent';
 a.node.querySelector('.badge').textContent={type:'Typing',key:'Key',scroll:'Scroll',drag:'Drag',error:'Refused'}[m.action]||'';
 a.node.style.opacity='1';
 const from={x:a.x,y:a.y}, mid={x:(a.x+m.x)/2,y:(a.y+m.y)/2-Math.min(35,Math.hypot(a.x-m.x,a.y-m.y)/5)};
 a.x=m.x;a.y=m.y;a.node.style.transform='translate('+a.x+'px,'+a.y+'px)';
 const motion=reduce.matches?0:220;
 if(motion && (from.x!==a.x||from.y!==a.y)) await a.node.animate([from,mid,a].map(p=>({transform:'translate('+p.x+'px,'+p.y+'px)'})),{duration:motion,easing:'cubic-bezier(.2,.8,.2,1)'}).finished.catch(()=>{});
 if(m.action==='click')a.node.querySelector('.ripple').animate([{opacity:.8,transform:'scale(.5)'},{opacity:0,transform:'scale(2)'}],{duration:reduce.matches?1:300});
 if(m.action==='error'&&!reduce.matches)a.node.animate([0,-4,4,-3,0].map(d=>({transform:'translate('+(a.x+d)+'px,'+a.y+'px)'})),{duration:240});
 a.timer=setTimeout(async()=>{await a.node.animate([{opacity:1},{opacity:0}],{duration:reduce.matches?1:220,fill:'forwards'}).finished.catch(()=>{});if(a.generation===generation)remove(a)},10000);
 return true;
};
</script>`;

export const makeAgentCursor = () => {
  let panel: import("electron").BrowserWindow | undefined;
  let loading: Promise<void> | undefined;
  let idle: ReturnType<typeof setTimeout> | undefined;
  const sources = new Map<string, Set<string>>();
  const close = () => {
    clearTimeout(idle);
    idle = undefined;
    panel?.destroy();
    panel = undefined;
    loading = undefined;
    sources.clear();
  };
  return {
    close,
    removeSource: async (sourceId: string) => {
      const threads = sources.get(sourceId);
      sources.delete(sourceId);
      if (!panel || panel.isDestroyed() || !threads) return;
      await panel.webContents.executeJavaScript(
        `window.removeAgentCursors(${JSON.stringify([...threads])})`,
      );
      if (sources.size === 0) close();
    },
    show: async (sourceId: string, message: DesktopComputerUseCursor): Promise<boolean> => {
      // Only the opt-in macOS server emits this message. A panel needs no AX grants.
      const Electron = await import("electron");
      await Electron.app.whenReady();
      const bounds = Electron.screen.getPrimaryDisplay().bounds;
      if (
        !Number.isFinite(message.x) ||
        !Number.isFinite(message.y) ||
        message.x < bounds.x ||
        message.y < bounds.y ||
        message.x >= bounds.x + bounds.width ||
        message.y >= bounds.y + bounds.height
      )
        return false;
      if (!panel || panel.isDestroyed()) {
        panel = new Electron.BrowserWindow({
          ...bounds,
          type: "panel",
          focusable: false,
          frame: false,
          hasShadow: false,
          transparent: true,
          backgroundColor: "#00000000",
          show: false,
          skipTaskbar: true,
          movable: false,
          resizable: false,
          webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
        });
        panel.setIgnoreMouseEvents(true);
        panel.setAlwaysOnTop(true, "screen-saver");
        panel.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
        panel.setContentProtection(true);
        loading = panel.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(PAGE)}`);
      }
      const own = panel;
      await loading;
      if (own.isDestroyed()) return false;
      const threads = sources.get(sourceId) ?? new Set<string>();
      const threadId = `${sourceId}:${message.threadId}`;
      if (threads.size >= 32) threads.delete(threads.values().next().value!);
      threads.add(threadId);
      sources.set(sourceId, threads);
      clearTimeout(idle);
      own.showInactive();
      const ready: unknown = await own.webContents.executeJavaScript(
        `window.viewCodeAgentCursor(${JSON.stringify({
          ...message,
          threadId,
          x: message.x - bounds.x,
          y: message.y - bounds.y,
        })})`,
      );
      idle = setTimeout(() => {
        if (!own.isDestroyed()) own.hide();
        idle = undefined;
      }, 10_300);
      return ready === true;
    },
  };
};

export const AgentCursor = Context.Reference<ReturnType<typeof makeAgentCursor>>(
  "@t3tools/desktop/computerUse/AgentCursor",
  { defaultValue: makeAgentCursor },
);
