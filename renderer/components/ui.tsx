import { useId, type ButtonHTMLAttributes, type ReactNode } from "react";
import {
  Dialog,
  DropdownMenu,
  Popover,
  Select,
  Switch,
  Tooltip,
} from "radix-ui";
import { Check, ChevronDown, X } from "lucide-react";

export function Button({
  className = "",
  kind = "standard",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  kind?: "standard" | "primary" | "plain" | "danger" | "send";
}) {
  return (
    <button
      type="button"
      className={`button ${kind} ${className}`}
      {...props}
    />
  );
}
export function IconButton({
  label,
  children,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { label: string }) {
  return (
    <Tooltip.Root>
      <Tooltip.Trigger asChild>
        <Button
          kind="plain"
          className="icon-button"
          aria-label={label}
          {...props}
        >
          {children}
        </Button>
      </Tooltip.Trigger>
      <Tooltip.Portal>
        <Tooltip.Content className="tooltip" sideOffset={7}>
          {label}
        </Tooltip.Content>
      </Tooltip.Portal>
    </Tooltip.Root>
  );
}
export function Picker({
  label,
  value,
  onChange,
  options,
  disabled,
  className = "",
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: { value: string; label: string }[];
  disabled?: boolean;
  className?: string;
}) {
  const encode = (value: string) => `v:${value}`;
  return (
    <Select.Root
      value={encode(value)}
      onValueChange={(value) => onChange(value.slice(2))}
      disabled={disabled}
    >
      <Select.Trigger
        className={`button picker ${className}`}
        aria-label={label}
      >
        <Select.Value placeholder={label} />
        <ChevronDown size={12} />
      </Select.Trigger>
      <Select.Portal>
        <Select.Content
          className="menu picker-menu"
          position="popper"
          sideOffset={5}
        >
          <Select.ScrollUpButton>⌃</Select.ScrollUpButton>
          <Select.Viewport>
            {options.map((option) => (
              <Select.Item
                className="menu-item"
                key={option.value}
                value={encode(option.value)}
              >
                <Select.ItemText>{option.label}</Select.ItemText>
                <Select.ItemIndicator>
                  <Check size={13} />
                </Select.ItemIndicator>
              </Select.Item>
            ))}
          </Select.Viewport>
          <Select.ScrollDownButton>⌄</Select.ScrollDownButton>
        </Select.Content>
      </Select.Portal>
    </Select.Root>
  );
}
export function Menu({
  trigger,
  children,
  label,
}: {
  trigger: ReactNode;
  children: ReactNode;
  label?: string;
}) {
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <Button aria-label={label} kind="plain">
          {trigger}
        </Button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content className="menu" align="end" sideOffset={6}>
          {children}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
export function MenuItem({
  children,
  onSelect,
  danger,
  disabled,
}: {
  children: ReactNode;
  onSelect: () => void;
  danger?: boolean;
  disabled?: boolean;
}) {
  return (
    <DropdownMenu.Item
      className={`menu-item ${danger ? "danger-text" : ""}`}
      disabled={disabled}
      onSelect={onSelect}
    >
      {children}
    </DropdownMenu.Item>
  );
}
export function MenuSub({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <DropdownMenu.Sub>
      <DropdownMenu.SubTrigger className="menu-item">
        {title}
        <span>›</span>
      </DropdownMenu.SubTrigger>
      <DropdownMenu.Portal>
        <DropdownMenu.SubContent className="menu" sideOffset={5}>
          {children}
        </DropdownMenu.SubContent>
      </DropdownMenu.Portal>
    </DropdownMenu.Sub>
  );
}
export function Popup({
  trigger,
  children,
  label,
}: {
  trigger: ReactNode;
  children: ReactNode;
  label: string;
}) {
  return (
    <Popover.Root>
      <Popover.Trigger asChild>
        <Button kind="plain" aria-label={label}>
          {trigger}
        </Button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          className="popover stack"
          side="top"
          align="start"
          sideOffset={12}
          aria-label={label}
        >
          {children}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
export function Modal({
  title,
  children,
  open = true,
  onClose,
  busy = false,
  className = "",
}: {
  title: string;
  children: ReactNode;
  open?: boolean;
  onClose: () => void;
  busy?: boolean;
  className?: string;
}) {
  return (
    <Dialog.Root
      open={open}
      onOpenChange={(value) => {
        if (!value && !busy) onClose();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="modal-overlay" />
        <Dialog.Content
          className={`modal stack ${className}`}
          onEscapeKeyDown={(event) => {
            if (busy) event.preventDefault();
          }}
          onPointerDownOutside={(event) => event.preventDefault()}
          aria-describedby={undefined}
        >
          <div className="row">
            <Dialog.Title>{title}</Dialog.Title>
            <span className="spacer" />
            <Dialog.Close asChild>
              <IconButton label="关闭" disabled={busy}>
                <X size={16} />
              </IconButton>
            </Dialog.Close>
          </div>
          {children}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
export function Toggle({
  checked,
  onChange,
  children,
}: {
  checked: boolean;
  onChange: (value: boolean) => void;
  children: ReactNode;
}) {
  const id = useId();
  return (
    <label className="row toggle-label" htmlFor={id}>
      <Switch.Root
        className="switch"
        id={id}
        checked={checked}
        onCheckedChange={onChange}
      >
        <Switch.Thumb className="switch-thumb" />
      </Switch.Root>
      {children}
    </label>
  );
}
export function Field({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <label className="field">
      <span>{title}</span>
      {children}
    </label>
  );
}
export function Header({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: string;
  children?: ReactNode;
}) {
  return (
    <header className="page-header">
      <div>
        <h1>{title}</h1>
        {subtitle && <p className="caption ellipsis">{subtitle}</p>}
      </div>
      <div className="row header-actions">{children}</div>
    </header>
  );
}
export function Notice({
  children,
  error = false,
}: {
  children?: ReactNode;
  error?: boolean;
}) {
  return children ? (
    <div
      className={error ? "notice error" : "notice"}
      role={error ? "alert" : "status"}
    >
      {children}
    </div>
  ) : null;
}
export function SelectionRow({
  children,
  selected,
  onClick,
}: {
  children: ReactNode;
  selected?: boolean;
  onClick: () => void;
}) {
  return (
    <Button
      kind="plain"
      className={`selection-row ${selected ? "selected" : ""}`}
      onClick={onClick}
      aria-pressed={selected}
    >
      {children}
    </Button>
  );
}
