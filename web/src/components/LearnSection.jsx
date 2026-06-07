import { motion } from 'framer-motion';
import { Card } from '../ui/Card.jsx';

export function LearnSection({ index, title, children }) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 16 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, amount: 0.3 }}
      transition={{ duration: 0.4 }}
    >
      <Card className="mb-4 p-5">
        <div className="mb-2 flex items-center gap-2">
          <span className="flex h-6 w-6 items-center justify-center rounded-full bg-brand-500 text-xs font-bold text-white">
            {index}
          </span>
          <h2 className="text-lg font-semibold text-slate-900">{title}</h2>
        </div>
        <div className="text-sm leading-relaxed text-slate-600">{children}</div>
      </Card>
    </motion.div>
  );
}
