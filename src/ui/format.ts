/** Номер остановки всегда двузначный: «01», «07», «12» — как на табличке и в игре. */
export const pad2 = (n: number): string => String(n).padStart(2, '0');
