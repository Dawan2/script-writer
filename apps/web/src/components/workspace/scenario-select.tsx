"use client";

import { Check, ChevronDown } from "lucide-react";
import { Fragment, useEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";
import type { LucideIcon } from "lucide-react";

export type ScenarioSelectOption<T extends string> = {
  key: T;
  label: string;
  icon?: LucideIcon;
  color?: string;
  group?: string;
};

type ScenarioSelectProps<T extends string> = {
  ariaLabel: string;
  disabled?: boolean;
  listId: string;
  onChange: (value: T) => void;
  options: readonly ScenarioSelectOption<T>[];
  showIcons?: boolean;
  value: T;
  variant: "task" | "filter" | "region";
};

function scenarioColorStyle(color?: string): CSSProperties {
  return { "--scenario-color": color ?? "var(--ocean)" } as CSSProperties;
}

export function ScenarioSelect<T extends string>({
  ariaLabel,
  disabled = false,
  listId,
  onChange,
  options,
  showIcons = true,
  value,
  variant
}: ScenarioSelectProps<T>) {
  const [open, setOpen] = useState(false);
  const selectRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const selectedScenario = options.find((scenario) => scenario.key === value) ?? options[0]!;
  const SelectedIcon = selectedScenario.icon;

  useEffect(() => {
    function handlePointerDown(event: PointerEvent) {
      if (!selectRef.current?.contains(event.target as Node)) setOpen(false);
    }

    document.addEventListener("pointerdown", handlePointerDown);
    return () => document.removeEventListener("pointerdown", handlePointerDown);
  }, []);

  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);

  function chooseScenario(nextValue: T) {
    onChange(nextValue);
    setOpen(false);
    window.requestAnimationFrame(() => triggerRef.current?.focus());
  }

  return (
    <div className={`scenario-select scenario-select--${variant}${showIcons ? "" : " scenario-select--without-icons"}`} ref={selectRef}>
      <button
        ref={triggerRef}
        className="scenario-select-trigger"
        type="button"
        disabled={disabled}
        aria-label={`${ariaLabel}，当前为${selectedScenario.label}`}
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-controls={open ? listId : undefined}
        onClick={() => setOpen((current) => !current)}
        onKeyDown={(event) => {
          if (event.key === "Escape" && open) {
            event.preventDefault();
            setOpen(false);
          }
          if ((event.key === "ArrowDown" || event.key === "ArrowUp") && !open) {
            event.preventDefault();
            setOpen(true);
          }
        }}
      >
        {showIcons && SelectedIcon ? (
          <span className="scenario-select-icon" aria-hidden="true" style={scenarioColorStyle(selectedScenario.color)}>
            <SelectedIcon size={16} />
          </span>
        ) : null}
        <span className="scenario-select-label">{selectedScenario.label}</span>
        <ChevronDown size={15} aria-hidden="true" />
      </button>
      {open ? (
        <div className="scenario-select-options" id={listId} role="listbox" aria-label={ariaLabel}>
          {options.map((scenario, index) => {
            const ScenarioIcon = scenario.icon;
            const selected = scenario.key === value;
            const showGroupLabel = Boolean(scenario.group && scenario.group !== options[index - 1]?.group);
            return (
              <Fragment key={scenario.key}>
                {showGroupLabel ? <span className="scenario-select-group-label" aria-hidden="true">{scenario.group}</span> : null}
                <button
                  className={`scenario-select-option${selected ? " selected" : ""}`}
                  type="button"
                  role="option"
                  aria-selected={selected}
                  style={scenarioColorStyle(scenario.color)}
                  onClick={() => chooseScenario(scenario.key)}
                  onKeyDown={(event) => {
                    if (event.key === "Escape") {
                      event.preventDefault();
                      setOpen(false);
                      window.requestAnimationFrame(() => triggerRef.current?.focus());
                    }
                  }}
                >
                  {showIcons && ScenarioIcon ? <span className="scenario-select-icon" aria-hidden="true"><ScenarioIcon size={16} /></span> : null}
                  <span>{scenario.label}</span>
                  {selected ? <Check size={15} aria-hidden="true" /> : null}
                </button>
              </Fragment>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
