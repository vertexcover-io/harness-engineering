import React from "react";
import { clsx } from "clsx";
import { Tooltip } from "./Tooltip";
import styles from "./Button.module.css";

export interface ButtonProps {
  variant?: "primary" | "secondary" | "ghost" | "danger";
  size?: "xs" | "sm" | "md" | "lg";
  onClick?: (event: React.MouseEvent<HTMLButtonElement>) => void;
  disabled?: boolean;
  loading?: boolean;
  tooltip?: string;
  icon?: React.ReactNode;
  children: React.ReactNode;
}

export function Button({
  variant = "primary",
  size = "md",
  onClick,
  disabled = false,
  loading = false,
  tooltip,
  icon,
  children,
}: ButtonProps) {
  const button = (
    <button
      className={clsx(styles.button, styles[variant], styles[size], {
        [styles.loading]: loading,
      })}
      onClick={onClick}
      disabled={disabled || loading}
      aria-busy={loading}
    >
      {icon && <span className={styles.icon}>{icon}</span>}
      {loading ? <span className={styles.spinner} /> : children}
    </button>
  );

  if (tooltip) {
    return <Tooltip content={tooltip}>{button}</Tooltip>;
  }

  return button;
}
