export class Inbox {
    #nextTurn = [];
    #nextStep = [];
    get nextTurn() {
        return this.#nextTurn;
    }
    get nextStep() {
        return this.#nextStep;
    }
    clear() {
        this.#nextTurn = [];
        this.#nextStep = [];
    }
    append(target, message) {
        this.#list(target).push(message);
    }
    prepend(target, message) {
        this.#list(target).unshift(message);
    }
    replace(messageId, newMessage) {
        const list = this.#find(messageId);
        if (list === undefined)
            return false;
        const index = list.findIndex((message) => message.id === messageId);
        if (index < 0)
            return false;
        list.splice(index, 1, newMessage);
        return true;
    }
    remove(messageId) {
        const list = this.#find(messageId);
        if (list === undefined)
            return false;
        const index = list.findIndex((message) => message.id === messageId);
        if (index < 0)
            return false;
        list.splice(index, 1);
        return true;
    }
    splice(target, start, deleteCount, inserted) {
        return this.#list(target).splice(start, deleteCount, ...inserted);
    }
    #list(target) {
        return target === "next-turn" ? this.#nextTurn : this.#nextStep;
    }
    #find(messageId) {
        if (this.#nextTurn.some((message) => message.id === messageId))
            return this.#nextTurn;
        if (this.#nextStep.some((message) => message.id === messageId))
            return this.#nextStep;
        return undefined;
    }
}
