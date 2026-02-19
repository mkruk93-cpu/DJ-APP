"use client";

import { useRadioStore } from "@/lib/radioStore";
import { getSocket } from "@/lib/socket";
import { getRadioToken } from "@/lib/auth";
import {
  DndContext,
  closestCenter,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  verticalListSortingStrategy,
  useSortable,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { QueueItem } from "@/lib/types";

function SortableItem({ item, index }: { item: QueueItem; index: number }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id: item.id });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  };

  function handleRemove() {
    const token = getRadioToken();
    if (!token) return;
    getSocket().emit("queue:remove", { id: item.id, token });
  }

  function handleMoveToTop() {
    const token = getRadioToken();
    if (!token) return;
    getSocket().emit("queue:reorder", { id: item.id, newPosition: 1, token });
  }

  return (
    <div
      ref={setNodeRef}
      style={style}
      className="flex items-center gap-2 rounded-lg border border-gray-800 bg-gray-800/50 p-2 transition hover:border-gray-700"
    >
      <button
        {...attributes}
        {...listeners}
        className="flex h-8 w-6 shrink-0 cursor-grab items-center justify-center text-gray-500 hover:text-gray-300 active:cursor-grabbing"
        title="Sleep om te herordenen"
      >
        <svg className="h-4 w-4" fill="currentColor" viewBox="0 0 24 24">
          <circle cx="9" cy="6" r="1.5" />
          <circle cx="15" cy="6" r="1.5" />
          <circle cx="9" cy="12" r="1.5" />
          <circle cx="15" cy="12" r="1.5" />
          <circle cx="9" cy="18" r="1.5" />
          <circle cx="15" cy="18" r="1.5" />
        </svg>
      </button>

      <span className="w-5 shrink-0 text-center text-xs font-medium text-gray-500">
        {index + 1}
      </span>

      {item.thumbnail && (
        <img
          src={item.thumbnail}
          alt=""
          className="h-10 w-14 shrink-0 rounded object-cover"
        />
      )}

      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium text-white">
          {item.title ?? "Laden..."}
        </p>
        <p className="truncate text-xs text-gray-400">{item.added_by}</p>
      </div>

      <div className="flex shrink-0 gap-1">
        {index > 0 && (
          <button
            onClick={handleMoveToTop}
            className="rounded-md bg-gray-700 p-1.5 text-gray-400 transition hover:bg-gray-600 hover:text-white"
            title="Zet bovenaan"
          >
            <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M5 15l7-7 7 7" />
            </svg>
          </button>
        )}
        <button
          onClick={handleRemove}
          className="rounded-md bg-red-600/20 p-1.5 text-red-400 transition hover:bg-red-600/30"
          title="Verwijderen"
        >
          <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>
    </div>
  );
}

export default function QueueManager() {
  const queue = useRadioStore((s) => s.queue);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));

  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over || active.id === over.id) return;

    const token = getRadioToken();
    if (!token) return;

    const overIndex = queue.findIndex((q) => q.id === over.id);
    if (overIndex === -1) return;

    getSocket().emit("queue:reorder", {
      id: active.id as string,
      newPosition: overIndex + 1,
      token,
    });
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-gray-500">
          Queue beheer
        </h3>
        <span className="text-xs text-gray-500">
          {queue.length} {queue.length === 1 ? "nummer" : "nummers"}
        </span>
      </div>

      {queue.length === 0 ? (
        <div className="rounded-xl border border-gray-800 bg-gray-900 p-6 text-center text-sm text-gray-500">
          Wachtrij is leeg
        </div>
      ) : (
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
          <SortableContext items={queue.map((q) => q.id)} strategy={verticalListSortingStrategy}>
            <div className="space-y-1">
              {queue.map((item, index) => (
                <SortableItem key={item.id} item={item} index={index} />
              ))}
            </div>
          </SortableContext>
        </DndContext>
      )}
    </div>
  );
}
