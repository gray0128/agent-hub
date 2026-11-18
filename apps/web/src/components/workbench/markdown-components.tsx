import type { Components } from "react-markdown";

export const MARKDOWN_COMPONENTS: Components = {
  table({ children, ...props }) {
    return (
      <div
        tabIndex={0}
        role="region"
        aria-label="数据表格"
        className="ahub-table-scroll"
      >
        <table {...props}>{children}</table>
      </div>
    );
  }
};
