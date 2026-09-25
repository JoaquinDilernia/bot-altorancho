import styles from './Composer.module.css';

export default function WhatsAppPreview({ imageUrl, text, buttonText }) {
  return (
    <div className={styles.phone}>
      <div className={styles.bubble}>
        {imageUrl && <img className={styles.bubbleImg} src={imageUrl} alt="" />}
        <div className={styles.bubbleText}>{text || 'Escribí el mensaje…'}</div>
        {buttonText && <div className={styles.bubbleBtn}>↗ {buttonText}</div>}
      </div>
    </div>
  );
}
