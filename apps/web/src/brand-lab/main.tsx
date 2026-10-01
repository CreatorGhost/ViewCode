// oxlint-disable shadcn/no-unknown-classes -- standalone lab styles live in style.css
import { useLayoutEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { Check, Moon, Sun } from "lucide-react";
import { concepts } from "./concepts";
import { directionColors, directions, directionVariables, marks } from "./directions";
import "../index.css";
import "../viewcode-theme.css";
import "./style.css";

function Mark({ index, size = 32 }: { index: number; size?: number }) {
  return (
    <span
      aria-hidden="true"
      className="lab-mark"
      style={{ width: size, height: size, maskImage: `url("${marks[index]!.asset}")` }}
    />
  );
}

function BrandLab() {
  const [directionIndex, setDirectionIndex] = useState(0);
  const [markIndex, setMarkIndex] = useState(0);
  const [conceptIndex, setConceptIndex] = useState(0);
  const concept = concepts[conceptIndex]!;
  const [appearance, setAppearance] = useState<"light" | "dark">("light");
  const direction = directions[directionIndex]!;

  useLayoutEffect(() => {
    const root = document.documentElement;
    for (const [key, value] of Object.entries(directionVariables(direction, appearance))) {
      root.style.setProperty(key, value);
    }
    root.classList.toggle("dark", appearance === "dark");
    root.style.colorScheme = appearance;
  }, [direction, appearance]);

  return (
    <main className="brand-lab">
      <header className="lab-masthead">
        <div className="lab-lockup">
          <Mark index={markIndex} />
          <strong>ViewCode</strong>
          <span>Mobile design lab</span>
        </div>
        <span className="lab-safety">Proposals only. Nothing applied to your app.</span>
      </header>
      <div className="lab-mobile-grid">
        <aside className="lab-directions" aria-label="Choose a theme direction">
          <div className="lab-section-title">
            <h2>Layout</h2>
            <span>5 concepts</span>
          </div>
          {concepts.map((item, index) => (
            <button
              type="button"
              key={item.name}
              className="lab-concept"
              aria-pressed={index === conceptIndex}
              onClick={() => setConceptIndex(index)}
            >
              <b>{item.name}</b>
            </button>
          ))}
          <div className="lab-section-title lab-section-gap">
            <h2>Theme</h2>
            <span>6 directions</span>
          </div>
          {directions.map((item, index) => {
            const colors = directionColors(item, appearance);
            return (
              <button
                type="button"
                key={item.id}
                className="lab-direction"
                aria-pressed={index === directionIndex}
                onClick={() => setDirectionIndex(index)}
              >
                <span className="lab-swatch" aria-hidden="true">
                  <i style={{ background: colors.canvas }} />
                  <i style={{ background: colors.surface }} />
                  <i style={{ background: colors.accent }} />
                </span>
                <span className="lab-direction-name">
                  <b>{item.name}</b>
                  <small>{item.character}</small>
                </span>
              </button>
            );
          })}
          <div className="lab-appearance">
            <button
              type="button"
              aria-pressed={appearance === "light"}
              onClick={() => setAppearance("light")}
            >
              <Sun size={14} /> Light
            </button>
            <button
              type="button"
              aria-pressed={appearance === "dark"}
              onClick={() => setAppearance("dark")}
            >
              <Moon size={14} /> Dark
            </button>
          </div>
        </aside>
        <section className="lab-stage" aria-label="Interactive phone preview">
          <div className="ph-device">
            <div className="ph-screen">
              <div className="ph-status" aria-hidden="true">
                <span>9:41</span>
                <span className="ph-island" />
                <span>5G</span>
              </div>
              <concept.Screen key={concept.name} mark={<Mark index={markIndex} size={18} />} />
              <span className="ph-home-bar" aria-hidden="true" />
            </div>
          </div>
          <p className="lab-hint">Fully interactive. Demo data only.</p>
        </section>
        <section className="lab-copy">
          <p className="lab-eyebrow">Layout</p>
          <h1>{concept.name}</h1>
          <p>{concept.idea}</p>
          <p className="lab-eyebrow">Theme · {direction.name}</p>
          <p>{direction.description}</p>
          <div className="lab-icon-row" aria-label="Launcher icon preview">
            {[60, 44, 29].map((size) => (
              <span key={size} className="lab-app-icon" style={{ width: size, height: size }}>
                <Mark index={markIndex} size={size * 0.62} />
              </span>
            ))}
          </div>
          <p className="lab-note">
            A web specimen of the phone layout. The native app keeps React Native navigation;
            colours would map onto its existing theme roles.
          </p>
        </section>
      </div>
      <section className="lab-identities" aria-label="Logo directions">
        <div className="lab-section-title">
          <div>
            <p className="lab-eyebrow">Identity · 12 marks</p>
            <h2>Tap a mark to try it on the phone.</h2>
          </div>
        </div>
        <div className="lab-logo-grid">
          {marks.map((mark, index) => (
            <button
              type="button"
              key={mark.name}
              className="lab-logo-card"
              aria-pressed={markIndex === index}
              onClick={() => setMarkIndex(index)}
            >
              <span className="lab-logo-number">
                {String(index + 1).padStart(2, "0")}
                {markIndex === index && <Check size={14} />}
              </span>
              <span className="lab-logo-stage">
                <Mark index={index} size={84} />
              </span>
              <span className="lab-logo-title">
                {mark.name}
                <span className="lab-small-marks">
                  <Mark index={index} size={14} />
                  <Mark index={index} size={22} />
                </span>
              </span>
              <span className="lab-logo-idea">{mark.idea}</span>
            </button>
          ))}
        </div>
      </section>
    </main>
  );
}

const root = document.getElementById("root");
if (!root) throw new Error("Brand lab root is missing");
createRoot(root).render(<BrandLab />);
