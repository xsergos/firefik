import { AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer, Legend } from "recharts";
import type { StatsResponse } from "@/types/api";

type Props = {
  data: StatsResponse["traffic"];
  gradientPrefix: string;
  unit: string;
};

export default function TrafficChart({ data, gradientPrefix, unit }: Props) {
  const acceptedId = `${gradientPrefix}Accepted`;
  const droppedId = `${gradientPrefix}Dropped`;
  return (
    <ResponsiveContainer width="100%" height={220}>
      <AreaChart data={data} margin={{ top: 4, right: 8, left: 8, bottom: 0 }}>
        <defs>
          <linearGradient id={acceptedId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="5%" stopColor="#22c55e" stopOpacity={0.25} />
            <stop offset="95%" stopColor="#22c55e" stopOpacity={0} />
          </linearGradient>
          <linearGradient id={droppedId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="5%" stopColor="#ef4444" stopOpacity={0.25} />
            <stop offset="95%" stopColor="#ef4444" stopOpacity={0} />
          </linearGradient>
        </defs>
        <XAxis
          dataKey="ts"
          tickFormatter={(v: string) =>
            new Date(v).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
          }
          tick={{ fontSize: 11 }}
          minTickGap={40}
        />
        <YAxis
          tick={{ fontSize: 11 }}
          width={48}
          allowDecimals={false}
          label={{
            value: unit,
            angle: -90,
            position: "insideLeft",
            style: { fontSize: 11, textAnchor: "middle" },
          }}
        />
        <Tooltip
          labelFormatter={(v) =>
            typeof v === "string" && v ? new Date(v).toLocaleTimeString() : ""
          }
          formatter={(value, name) => [
            `${value} ${unit}`,
            name === "accepted" ? "Accepted" : "Dropped",
          ]}
        />
        <Legend formatter={(v) => (v === "accepted" ? "Accepted" : "Dropped")} />
        <Area
          type="linear"
          dataKey="accepted"
          stroke="#22c55e"
          strokeWidth={2}
          fill={`url(#${acceptedId})`}
          dot={false}
        />
        <Area
          type="linear"
          dataKey="dropped"
          stroke="#ef4444"
          strokeWidth={2}
          fill={`url(#${droppedId})`}
          dot={false}
        />
      </AreaChart>
    </ResponsiveContainer>
  );
}
