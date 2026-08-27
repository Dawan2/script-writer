"use client";

import { Crown } from "lucide-react";
import { useLayoutEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";
import type { CharacterRelationshipGraph } from "@/lib/types";

type CharacterRelationshipMapProps = {
  graph?: CharacterRelationshipGraph | null;
};

type RelationshipConnection = {
  key: string;
  label: string;
  path: string;
  labelX: number;
  labelY: number;
  startX: number;
  startY: number;
  endX: number;
  endY: number;
};

const FACTION_COLORS = ["#236b56", "#be5b3c", "#2e6682", "#8a6b2f", "#7a4e8c", "#a4464f", "#2b7770", "#445d79"];
const OTHER_FACTION_COLOR = "#6c7472";

function colorStyle(color: string): CSSProperties {
  return { "--relationship-color": color } as CSSProperties;
}

function displayRoleIdentity(character: CharacterRelationshipGraph["characters"][number]) {
  return character.is_protagonist ? "主角" : character.role_identity;
}

function cubicPoint(start: number, controlOne: number, controlTwo: number, end: number, progress: number) {
  const inverse = 1 - progress;
  return inverse ** 3 * start
    + 3 * inverse ** 2 * progress * controlOne
    + 3 * inverse * progress ** 2 * controlTwo
    + progress ** 3 * end;
}

export function CharacterRelationshipMap({ graph }: CharacterRelationshipMapProps) {
  const [focusedName, setFocusedName] = useState<string | null>(null);
  const [selectedFaction, setSelectedFaction] = useState<string | null>(null);
  const [connections, setConnections] = useState<RelationshipConnection[]>([]);
  const [connectionCanvas, setConnectionCanvas] = useState({ width: 0, height: 0 });
  const boardRef = useRef<HTMLDivElement>(null);
  const focusCardRef = useRef<HTMLDivElement>(null);
  const branchRefs = useRef(new Map<string, HTMLDivElement>());
  const prepared = useMemo(() => {
    if (!graph) return null;
    const protagonist = graph.characters.find((character) => character.name === graph.protagonist && character.is_protagonist);
    if (!protagonist) return null;

    const factionCounts = new Map<string, number>();
    graph.characters.forEach((character) => {
      factionCounts.set(character.faction, (factionCounts.get(character.faction) ?? 0) + 1);
    });
    const displayFactionByName = new Map<string, string>();
    const factionColors = new Map<string, string>();
    graph.characters.forEach((character) => {
      const displayFaction = factionCounts.get(character.faction) === 1 ? "其他" : character.faction;
      displayFactionByName.set(character.name, displayFaction);
      if (!factionColors.has(displayFaction)) {
        const factionColorIndex = Array.from(factionColors.keys()).filter((faction) => faction !== "其他").length;
        factionColors.set(
          displayFaction,
          displayFaction === "其他" ? OTHER_FACTION_COLOR : FACTION_COLORS[factionColorIndex % FACTION_COLORS.length]
        );
      }
    });
    return { protagonist, factionColors, displayFactionByName };
  }, [graph]);

  if (!graph || !prepared) {
    return (
      <section className="relationship-map relationship-map-empty" aria-live="polite">
        <div>
          <h2>关系图谱尚待补全</h2>
          <p>重新生成人物小传后，即可查看角色的身份、阵营与关系。</p>
        </div>
      </section>
    );
  }

  const displayFaction = (character: CharacterRelationshipGraph["characters"][number]) => (
    prepared.displayFactionByName.get(character.name) ?? character.faction
  );
  const selectedFactionCharacters = selectedFaction
    ? graph.characters.filter((character) => displayFaction(character) === selectedFaction)
    : graph.characters;
  const hasActiveFactionFilter = selectedFaction !== null && selectedFactionCharacters.length > 0;
  const visibleCharacters = hasActiveFactionFilter ? selectedFactionCharacters : graph.characters;
  const visibleNames = new Set(visibleCharacters.map((character) => character.name));
  const defaultFocus = hasActiveFactionFilter ? visibleCharacters[0] : prepared.protagonist;
  const focused = visibleCharacters.find((character) => character.name === focusedName) ?? defaultFocus;
  const relationships = graph.relationships.flatMap((relationship) => {
    if (relationship.source === focused.name) {
      const character = graph.characters.find((item) => item.name === relationship.target);
      return character && visibleNames.has(character.name) ? [{ character, label: relationship.label }] : [];
    }
    if (relationship.target === focused.name) {
      const character = graph.characters.find((item) => item.name === relationship.source);
      return character && visibleNames.has(character.name) ? [{ character, label: relationship.label }] : [];
    }
    return [];
  });
  const relationshipItems = relationships.map(({ character, label }, index) => ({
    character,
    label,
    side: index % 2 === 0 ? "left" : "right",
    row: Math.floor(index / 2) + 1,
    key: `${focused.name}-${character.name}-${label}`
  }));
  const rowCount = Math.max(1, Math.ceil(relationships.length / 2));
  const relationshipSignature = relationshipItems.map((item) => item.key).join("|");

  useLayoutEffect(() => {
    const board = boardRef.current;
    const focusCard = focusCardRef.current;
    if (!board || !focusCard) return;

    let frameId = 0;
    const measure = () => {
      const boardBounds = board.getBoundingClientRect();
      const focusBounds = focusCard.getBoundingClientRect();
      const contentLeft = boardBounds.left + board.clientLeft;
      const contentTop = boardBounds.top + board.clientTop;
      const toContentX = (viewportX: number) => viewportX - contentLeft + board.scrollLeft;
      const toContentY = (viewportY: number) => viewportY - contentTop + board.scrollTop;
      const entries = relationshipItems
        .map((item) => ({ ...item, branch: branchRefs.current.get(item.key) }))
        .filter((item): item is typeof item & { branch: HTMLDivElement } => Boolean(item.branch));
      const leftEntries = entries.filter((item) => item.side === "left");
      const rightEntries = entries.filter((item) => item.side === "right");
      const sideOrder = new Map<string, number>();
      leftEntries.forEach((item, index) => sideOrder.set(item.key, index));
      rightEntries.forEach((item, index) => sideOrder.set(item.key, index));

      const nextConnections = entries.flatMap((item) => {
        const card = item.branch.querySelector<HTMLElement>(".relationship-character-card");
        if (!card) return [];
        const cardBounds = card.getBoundingClientRect();
        const isLeft = item.side === "left";
        const sideEntries = isLeft ? leftEntries : rightEntries;
        const ordinal = sideOrder.get(item.key) ?? 0;
        const startX = toContentX(isLeft ? cardBounds.right : cardBounds.left);
        const startY = toContentY(cardBounds.top + cardBounds.height / 2);
        const endX = toContentX(isLeft ? focusBounds.left : focusBounds.right);
        const endY = toContentY(
          focusBounds.top + focusBounds.height * ((ordinal + 1) / (sideEntries.length + 1))
        );
        const direction = isLeft ? 1 : -1;
        const bend = Math.min(160, Math.max(52, Math.abs(endX - startX) * 0.42));
        const controlOneX = startX + direction * bend;
        const controlTwoX = endX - direction * bend;
        const labelProgress = 0.44;
        return [{
          key: item.key,
          label: item.label,
          path: `M ${startX} ${startY} C ${controlOneX} ${startY}, ${controlTwoX} ${endY}, ${endX} ${endY}`,
          labelX: cubicPoint(startX, controlOneX, controlTwoX, endX, labelProgress),
          labelY: cubicPoint(startY, startY, endY, endY, labelProgress),
          startX,
          startY,
          endX,
          endY
        }];
      });

      setConnectionCanvas({ width: board.scrollWidth, height: board.scrollHeight });
      setConnections(nextConnections);
    };
    const scheduleMeasure = () => {
      window.cancelAnimationFrame(frameId);
      frameId = window.requestAnimationFrame(measure);
    };
    const observer = new ResizeObserver(scheduleMeasure);
    observer.observe(board);
    observer.observe(focusCard);
    branchRefs.current.forEach((branch) => observer.observe(branch));
    board.addEventListener("scroll", scheduleMeasure, { passive: true });
    window.addEventListener("resize", scheduleMeasure);
    scheduleMeasure();

    return () => {
      window.cancelAnimationFrame(frameId);
      observer.disconnect();
      board.removeEventListener("scroll", scheduleMeasure);
      window.removeEventListener("resize", scheduleMeasure);
    };
  }, [focused.name, relationshipSignature]);

  return (
    <section className="relationship-map">
      <div className="relationship-roster" aria-label="阵营筛选">
        <button
          type="button"
          className={`relationship-roster-item all${selectedFaction === null ? " active" : ""}`}
          aria-pressed={selectedFaction === null}
          onClick={() => {
            setSelectedFaction(null);
            setFocusedName(null);
          }}
        >
          全部
        </button>
        {Array.from(prepared.factionColors.entries())
          .sort(([leftFaction], [rightFaction]) => Number(leftFaction === "其他") - Number(rightFaction === "其他"))
          .map(([faction, color]) => {
            const selected = selectedFaction === faction;
            return (
              <button
                key={faction}
                type="button"
                className={`relationship-roster-item${selected ? " active" : ""}`}
                style={colorStyle(color)}
                aria-pressed={selected}
                title={faction}
                onClick={() => {
                  setSelectedFaction(faction);
                  setFocusedName(null);
                }}
              >
                <i aria-hidden="true" />
                {faction}
              </button>
            );
          })}
      </div>

      <div
        ref={boardRef}
        className="relationship-map-board"
        style={{ "--relationship-row-count": rowCount } as CSSProperties}
      >
        {connectionCanvas.width && connectionCanvas.height ? (
          <svg
            className="relationship-connection-lines"
            aria-hidden="true"
            viewBox={`0 0 ${connectionCanvas.width} ${connectionCanvas.height}`}
            preserveAspectRatio="none"
            style={{ width: connectionCanvas.width, height: connectionCanvas.height }}
          >
            {connections.map((connection) => (
              <g key={connection.key}>
                <path d={connection.path} />
                <circle cx={connection.startX} cy={connection.startY} r="1.8" />
                <circle cx={connection.endX} cy={connection.endY} r="2.4" />
              </g>
            ))}
          </svg>
        ) : null}
        {connections.map((connection) => (
          <span
            key={connection.key}
            className="relationship-link-label"
            style={{ left: connection.labelX, top: connection.labelY }}
            title={connection.label}
          >
            {connection.label}
          </span>
        ))}
        <article
          className="relationship-focus-card"
          style={colorStyle(prepared.factionColors.get(displayFaction(focused))!)}
        >
          <div ref={focusCardRef} className="relationship-focus-card-content">
            <span className="relationship-card-faction" title={displayFaction(focused)}>{displayFaction(focused)}</span>
            {focused.is_protagonist ? (
              <span className="relationship-protagonist-mark" role="img" aria-label="主角" title="主角">
                <Crown size={15} strokeWidth={2.25} aria-hidden="true" />
              </span>
            ) : null}
            <strong title={focused.name}>{focused.name}</strong>
            <p title={displayRoleIdentity(focused)}>{displayRoleIdentity(focused)}</p>
          </div>
        </article>

        {relationshipItems.map(({ character, side, row, key }) => {
          const card = (
            <button
              type="button"
              className="relationship-character-card"
              style={colorStyle(prepared.factionColors.get(displayFaction(character))!)}
              aria-label={`${character.name}，${displayRoleIdentity(character)}`}
              title={`${character.name}，${displayRoleIdentity(character)}`}
              onClick={() => setFocusedName(character.name)}
            >
              <span className="relationship-card-faction" title={displayFaction(character)}>{displayFaction(character)}</span>
              <strong title={character.name}>{character.name}</strong>
              <small title={displayRoleIdentity(character)}>{displayRoleIdentity(character)}</small>
            </button>
          );
          return (
            <div
              key={key}
              ref={(node) => {
                if (node) branchRefs.current.set(key, node);
                else branchRefs.current.delete(key);
              }}
              className={`relationship-branch ${side}`}
              style={{ gridRow: row }}
            >
              {card}
            </div>
          );
        })}

        {!relationships.length ? (
          <p className="relationship-map-no-links">没有与其他关键角色的直接关系。</p>
        ) : null}
      </div>
    </section>
  );
}
